import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewSession, ReviewError } from '../src/review.js';
import { createRuleSnapshot } from '../src/rules.js';

const OPEN = '2026-09-18T08:00:00+08:00';
const DEADLINE = '2026-09-19T09:00:00+08:00';

function makeSession(overrides = {}) {
  const roster = overrides.roster ?? [
    { institutionId: 'B01', name: '甲', status: 'active' },
    { institutionId: 'B02', name: '乙', status: 'active' },
    { institutionId: 'B03', name: '丙', status: 'active' },
    { institutionId: 'B04', name: '丁', status: 'active' },
    { institutionId: 'B99', name: '未入名单', status: 'suspended' },
  ];
  const reviewers = overrides.reviewers ?? [
    { id: 'R1', name: '审一', status: 'active', affiliatedInstitutionIds: [] },
    { id: 'R2', name: '审二', status: 'active', affiliatedInstitutionIds: [] },
    { id: 'R3', name: '审三', status: 'active', affiliatedInstitutionIds: ['B01'] },
  ];
  const minQuorum = overrides.minQuorum ?? 4;
  return createReviewSession({
    cycle: { cycleId: 'T-01', windowOpenAt: OPEN, deadlineAt: DEADLINE },
    roster,
    reviewers,
    rule: createRuleSnapshot({ quorum: { allRosterSlotsRequired: true, minIncludedPerTenor: minQuorum } }),
  });
}

function payload(overrides = {}) {
  return {
    submissionId: 'S1',
    institutionId: 'B01',
    tenor: '1Y',
    value: 3.1,
    unit: 'percent',
    sourceDescription: '行内模型',
    ...overrides,
  };
}

// 为4家名单机构的两个期限各报一份合规报价。
function fillAll(session, at = '2026-09-18T09:00:00+08:00') {
  for (const institutionId of ['B01', 'B02', 'B03', 'B04']) {
    for (const tenor of ['1Y', '5Y+']) {
      session.submit(payload({ institutionId, tenor, value: 3.1, submissionId: `S-${institutionId}-${tenor}` }), { now: at });
    }
  }
}

test('截止前更正形成新版本并保留旧版本与修订理由', () => {
  const session = makeSession();
  const first = session.submit(payload({ value: 3.1 }), { now: '2026-09-18T09:00:00+08:00' });
  assert.equal(first.status, 'valid');

  // 内容变化但没有修订理由，拒绝成为新版本。
  const noReason = session.submit(payload({ value: 3.15 }), { now: '2026-09-18T10:00:00+08:00' });
  assert.equal(noReason.accepted, false);
  assert.equal(noReason.reason, 'REVISION_REASON_REQUIRED');

  const revised = session.submit(
    payload({ value: 3.15, revisionReason: '资金面变化，经行内重审后调整5个基点' }),
    { now: '2026-09-18T11:00:00+08:00' },
  );
  assert.equal(revised.accepted, true);
  assert.equal(revised.versionId, 'B01-1Y-v2');

  const view = session.institutionView('B01');
  const [slot] = view.submissions;
  assert.equal(slot.currentVersionId, 'B01-1Y-v2');
  assert.equal(slot.versions[0].status, 'superseded');
  assert.equal(slot.versions[1].status, 'valid');
  assert.equal(slot.versions[1].revisionReason, '资金面变化，经行内重审后调整5个基点');
});

test('截止后补报仅登记，不得悄悄进入当期，也不能补齐缺报', () => {
  const session = makeSession();
  fillAll(session);
  // B01 的 1Y 视为缺失：另建一个会话，B01只报5Y+，1Y在截止后补。
  const session2 = makeSession();
  for (const institutionId of ['B01', 'B02', 'B03', 'B04']) {
    session2.submit(payload({ institutionId, tenor: '5Y+', submissionId: `S-${institutionId}-5Y` }), {
      now: '2026-09-18T09:00:00+08:00',
    });
  }
  for (const institutionId of ['B02', 'B03', 'B04']) {
    session2.submit(payload({ institutionId, tenor: '1Y', submissionId: `S-${institutionId}-1Y` }), {
      now: '2026-09-18T09:00:00+08:00',
    });
  }
  const late = session2.submit(payload({ institutionId: 'B01', tenor: '1Y' }), {
    now: '2026-09-19T10:00:00+08:00',
  });
  assert.equal(late.accepted, false);
  assert.equal(late.registered, 'late');

  const blockers = session2.freezeBlockers();
  assert.ok(blockers.some((b) => b.code === 'MISSING_REPORT' && b.institutionId === 'B01' && b.tenor === '1Y'));
  // 截止后来件对机构自身可见，状态明确为备查。
  const view = session2.institutionView('B01');
  assert.equal(view.submissions.find((s) => s.tenor === '1Y').lateIntakes.length, 1);
});

test('窗口开启前不予受理', () => {
  const session = makeSession();
  const result = session.submit(payload(), { now: '2026-09-18T07:59:00+08:00' });
  assert.deepEqual(result, { accepted: false, reason: 'WINDOW_NOT_OPEN' });
  assert.equal(session.slots.length, 0);
});

test('无资格机构来件隔离登记，不产生机构材料', () => {
  const session = makeSession();
  const result = session.submit(payload({ institutionId: 'B99' }), { now: '2026-09-18T09:00:00+08:00' });
  assert.equal(result.registered, 'stray');
  assert.equal(session.institutionView('B99').allowed, false);
  assert.equal(session.strayIntakes.length, 1);
});

test('无法识别期限的来件单独登记', () => {
  const session = makeSession();
  const result = session.submit(payload({ tenor: '2Y' }), { now: '2026-09-18T09:00:00+08:00' });
  assert.equal(result.registered, 'malformed');
  assert.equal(session.malformedIntakes.length, 1);
});

test('重复报送挂起并阻断冻结，双人认定作废后放行', () => {
  const session = makeSession();
  fillAll(session);
  session.submit(payload({ institutionId: 'B01', tenor: '1Y', value: 3.1, submissionId: 'DUP' }), {
    now: '2026-09-18T12:00:00+08:00',
  });
  assert.ok(session.freezeBlockers().some((b) => b.code === 'DUPLICATE_UNRESOLVED'));

  session.proposeDecision({
    kind: 'VOID_DUPLICATE',
    institutionId: 'B01',
    tenor: '1Y',
    versionId: 'B01-1Y-v2',
    reason: '邮件表格重复提交',
    proposedBy: 'R1',
  });
  // 仅一人提出时仍阻断。
  assert.ok(session.freezeBlockers().some((b) => b.code === 'PENDING_DUAL_CONFIRMATION'));
  session.confirmDecision('dec-001', { confirmedBy: 'R2' });
  assert.deepEqual(session.freezeBlockers(), []);
});

test('单位错误版本阻断冻结，截止前更正后解除', () => {
  const session = makeSession();
  fillAll(session);
  // 用一个未报送的干净槽位重放：新建会话，B01 1Y 首报单位错误。
  const session2 = makeSession();
  for (const institutionId of ['B01', 'B02', 'B03', 'B04']) {
    session2.submit(payload({ institutionId, tenor: '5Y+' }), { now: '2026-09-18T09:00:00+08:00' });
  }
  for (const institutionId of ['B02', 'B03', 'B04']) {
    session2.submit(payload({ institutionId, tenor: '1Y' }), { now: '2026-09-18T09:00:00+08:00' });
  }
  const bad = session2.submit(payload({ value: 310, unit: 'bp' }), { now: '2026-09-18T09:30:00+08:00' });
  assert.equal(bad.status, 'invalid');
  const blocker = session2.freezeBlockers().find((b) => b.code === 'FORMAT_INVALID');
  assert.ok(blocker.errors.includes('UNIT_INVALID'));

  session2.submit(
    payload({ value: 3.1, revisionReason: '经办误用基点口径，更正为百分数' }),
    { now: '2026-09-18T10:00:00+08:00' },
  );
  assert.deepEqual(session2.freezeBlockers(), []);
});

test('回避分派排除利害关系审核员，同人不能二次确认', () => {
  const session = makeSession();
  fillAll(session);
  const pair = session.suggestReviewerPair('B01');
  assert.deepEqual(pair.map((p) => p.id), ['R1', 'R2']);
  assert.ok(!pair.some((p) => p.id === 'R3'));

  session.proposeDecision({
    kind: 'EXCLUDE',
    institutionId: 'B01',
    tenor: '1Y',
    reason: '口径错误',
    proposedBy: 'R1',
  });
  assert.throws(
    () => session.confirmDecision('dec-001', { confirmedBy: 'R1' }),
    (error) => error instanceof ReviewError && error.code === 'SAME_CONFIRMER',
  );
  assert.throws(
    () => session.confirmDecision('dec-001', { confirmedBy: 'R3' }),
    (error) => error instanceof ReviewError && error.code === 'CONFLICT_RECUSAL',
  );
  assert.throws(
    () =>
      session.proposeDecision({
        kind: 'EXCLUDE',
        institutionId: 'B01',
        tenor: '1Y',
        reason: '利害关系人提出',
        proposedBy: 'R3',
      }),
    (error) => error.code === 'CONFLICT_RECUSAL',
  );
});

test('剔除与恢复均须双人确认并记录当时规则版本', () => {
  const session = makeSession();
  fillAll(session);
  session.proposeDecision({
    kind: 'EXCLUDE',
    institutionId: 'B01',
    tenor: '1Y',
    reason: '核实为特殊客户收益率口径',
    proposedBy: 'R1',
  });
  // 待确认期间仍纳入。
  assert.equal(session.freezeBlockers().some((b) => b.code === 'PENDING_DUAL_CONFIRMATION'), true);
  session.confirmDecision('dec-001', { confirmedBy: 'R2' });

  const excludedVersion = session.slots.find((s) => s.institutionId === 'B01' && s.tenor === '1Y');
  assert.equal(excludedVersion.currentVersionId, 'B01-1Y-v1');

  // 恢复同样双人。
  session.proposeDecision({
    kind: 'RESTORE',
    institutionId: 'B01',
    tenor: '1Y',
    reason: '机构补充材料证明口径无误',
    proposedBy: 'R2',
  });
  session.confirmDecision('dec-002', { confirmedBy: 'R1' });
  const ledger = session.decisions;
  assert.equal(ledger[0].ruleVersion, createRuleSnapshot().version);
  assert.equal(ledger.every((d) => d.status === 'applied'), true);
});

test('法定数量不足阻断冻结', () => {
  const session = makeSession();
  // 只报3家，低于每期限4家的最低数量。
  for (const institutionId of ['B01', 'B02', 'B03']) {
    for (const tenor of ['1Y', '5Y+']) {
      session.submit(payload({ institutionId, tenor }), { now: '2026-09-18T09:00:00+08:00' });
    }
  }
  const result = session.freeze({ operatorId: 'R1' });
  assert.equal(result.frozen, false);
  assert.ok(result.blockers.some((b) => b.code === 'QUORUM_NOT_MET' && b.tenor === '1Y'));
});

test('冻结包列出纳入、排除理由、签署与规则快照，且摘要可复算', () => {
  const session = makeSession({ minQuorum: 3 });
  fillAll(session);
  session.proposeDecision({
    kind: 'EXCLUDE',
    institutionId: 'B01',
    tenor: '1Y',
    reason: '口径错误经核实',
    proposedBy: 'R1',
  });
  session.confirmDecision('dec-001', { confirmedBy: 'R2' });

  const result = session.freeze({ operatorId: 'R1', now: DEADLINE });
  assert.equal(result.frozen, true);
  const pkg = result.package;
  assert.equal(pkg.included.filter((i) => i.tenor === '1Y').length, 3);
  assert.ok(pkg.excluded.some((e) => e.reasonCode === 'REVIEW_EXCLUDED' && e.institution.id === 'B01'));
  assert.equal(pkg.signRecords.length, 1);
  assert.deepEqual(pkg.signRecords[0].proposedBy, { id: 'R1', name: '审一' });
  assert.ok(pkg.ruleSnapshot.version);
  assert.match(pkg.digest, /^[0-9a-f]{64}$/);
  // 同一冻结包摘要稳定。
  assert.equal(pkg.digest, session.frozenPackage.digest);
});

test('冻结后不再受理任何报送或处置', () => {
  const session = makeSession();
  fillAll(session);
  session.freeze({ operatorId: 'R1' });
  assert.throws(() => session.submit(payload()), (e) => e.code === 'CYCLE_FROZEN');
  assert.throws(
    () => session.addReviewComment({ institutionId: 'B01', tenor: '1Y', reviewerId: 'R2', content: 'x' }),
    (e) => e.code === 'CYCLE_FROZEN',
  );
});

test('机构只能查看自身材料，看不到其他机构与冻结包', () => {
  const session = makeSession();
  fillAll(session);
  session.freeze({ operatorId: 'R1' });

  const view = session.institutionView('B02');
  assert.equal(view.allowed, true);
  assert.equal(view.submissions.every((slot) => slot.currentVersionId?.startsWith('B02-')), true);
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes('B01'));
  assert.ok(!serialized.includes('signRecords'));
  assert.ok(!serialized.includes('digest'));
});

test('审核意见同样执行回避，且随机构自身材料可见', () => {
  const session = makeSession();
  fillAll(session);
  assert.throws(
    () => session.addReviewComment({ institutionId: 'B01', tenor: '1Y', reviewerId: 'R3', content: '意见' }),
    (e) => e.code === 'CONFLICT_RECUSAL',
  );
  session.addReviewComment({ institutionId: 'B01', tenor: '1Y', reviewerId: 'R2', content: '请补充定价依据' });
  const view = session.institutionView('B01');
  assert.equal(view.submissions[0].versions[0].reviewComments[0].content, '请补充定价依据');
});
