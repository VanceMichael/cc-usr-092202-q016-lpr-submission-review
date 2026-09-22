import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseRecords } from '../src/records.js';
import {
  buildLedger,
  validateQuote,
  effectiveQuote,
  freezeBlockers,
  detectAnomalies,
  assignCase,
  confirmDecision,
  preFreezeCheck,
  freezePackage,
  bankView,
  reviewerView,
  mustRecuse,
  ACTIONS,
} from '../src/index.js';

const read = (name) => readFile(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

async function scenario() {
  const [rulesRaw, rosterRaw, submissionsRaw] = await Promise.all([
    read('period-2026-09.json'),
    read('roster.json'),
    read('submissions-2026-09.json'),
  ]);
  return buildLedger(rulesRaw, rosterRaw, submissionsRaw);
}

test('既有公开样例仍可读取且结构完整', async () => {
  const raw = await read('context.json');
  const value = parseRecords(raw);
  assert.equal(value.domain, 'lpr-submission-review');
  assert.ok(value.records.length >= 2);
});

test('格式校验：识别非数值、越界与错误步长', async () => {
  const { rules } = await scenario();
  assert.equal(validateQuote('x', '1Y', rules).ok, false);
  assert.equal(validateQuote(3.0, '2Y', rules).errors[0].code, 'UNKNOWN_TENOR');
  assert.equal(validateQuote(99, '1Y', rules).ok, false);
  assert.equal(validateQuote(3.055, '1Y', rules).errors[0].code, 'BAD_STEP');
  assert.ok(validateQuote(3.05, '1Y', rules).ok);
});

test('单位错误：误按小数比例(0.0305)与误按基点(305)都会被拦截', async () => {
  const { rules } = await scenario();
  const ratio = validateQuote(0.0305, '1Y', rules);
  assert.equal(ratio.ok, false);
  assert.equal(ratio.errors[0].code, 'UNIT_DECIMAL_RATIO');
  const bps = validateQuote(305, '1Y', rules);
  assert.equal(bps.ok, false);
  assert.equal(bps.errors[0].code, 'UNIT_BASIS_POINTS');
});

test('截止前更正形成新版本，历史版本保留，有效报价取最新版本', async () => {
  const { ledger } = await scenario();
  const versions = ledger.versionsByBank.get('B01');
  assert.equal(versions.length, 2);
  assert.equal(versions[0].status, 'accepted');
  assert.equal(versions[1].status, 'accepted');
  assert.equal(versions[1].is_correction, true);
  assert.equal(effectiveQuote(ledger, 'B01', '1Y').quote.value, 3.05);
  assert.equal(effectiveQuote(ledger, 'B01', '1Y').version.event_id, 'EV-006');
  // 未更正的期限沿用新版本中的维持值
  assert.equal(effectiveQuote(ledger, 'B01', '5Y_PLUS').quote.value, 3.55);
});

test('重复报送被登记为重复项并产生阻断，但不覆盖原报送', async () => {
  const ctx = await scenario();
  const dup = ctx.ledger.versionsByBank.get('B02').find((v) => v.event_id === 'EV-007');
  assert.equal(dup.status, 'duplicate');
  assert.equal(effectiveQuote(ctx.ledger, 'B02', '1Y').version.event_id, 'EV-002');
  const blockers = freezeBlockers(ctx.ledger, ctx.rules, ctx.roster);
  assert.ok(blockers.some((b) => b.code === 'DUPLICATE_SUBMISSION' && b.event_id === 'EV-007'));
});

test('截止后的补报与更正只登记为逾期，绝不进入当期有效报价', async () => {
  const { ledger } = await scenario();
  // B04 五年期以上仅有截止后(08:45，截止08:30)补报
  assert.equal(effectiveQuote(ledger, 'B04', '5Y_PLUS'), null);
  const lateSupplement = ledger.versionsByBank.get('B04').find((v) => v.event_id === 'EV-013');
  assert.equal(lateSupplement.status, 'late');
  // B09 截止后的上调更正不得覆盖截止前报价
  assert.equal(effectiveQuote(ledger, 'B09', '1Y').quote.value, 3.0);
  assert.equal(effectiveQuote(ledger, 'B09', '5Y_PLUS').quote.value, 3.55);
});

test('截止后仅有补报的期限按缺报处理并阻断冻结', async () => {
  const ctx = await scenario();
  const blockers = freezeBlockers(ctx.ledger, ctx.rules, ctx.roster);
  const b04 = blockers.find((b) => b.bank_id === 'B04');
  assert.equal(b04.code, 'MISSING_WITH_LATE_SUPPLEMENT');
  assert.equal(b04.tenor, '5Y_PLUS');
});

test('单位错误版本保留待更正，更正版本到位后恢复有效', async () => {
  const { ledger } = await scenario();
  const first = ledger.versionsByBank.get('B03').find((v) => v.event_id === 'EV-003');
  assert.equal(first.status, 'invalid');
  assert.equal(effectiveQuote(ledger, 'B03', '1Y').version.event_id, 'EV-008');
  assert.equal(effectiveQuote(ledger, 'B03', '1Y').quote.validation.ok, true);
});

test('无资格机构的报送被标记并阻断冻结', async () => {
  const ctx = await scenario();
  const version = ctx.ledger.versionsByBank.get('B08')[0];
  assert.equal(version.status, 'ineligible');
  const blockers = freezeBlockers(ctx.ledger, ctx.rules, ctx.roster);
  assert.ok(blockers.some((b) => b.code === 'INELIGIBLE_SUBMISSION' && b.bank_id === 'B08'));
});

test('异常提示：较上一期偏离超阈值的报价被标记，但不自动剔除', async () => {
  const ctx = await scenario();
  const anomalies = detectAnomalies(ctx.ledger, ctx.rules, ctx.roster);
  const flagged = anomalies.map((a) => `${a.bank_id}:${a.tenor}`).sort();
  assert.deepEqual(flagged, ['B04:1Y', 'B05:1Y', 'B05:5Y_PLUS']);
  // 异常报价在复核前仍计入候选范围
  assert.equal(effectiveQuote(ctx.ledger, 'B05', '5Y_PLUS').quote.value, 3.65);
});

test('回避分派：关联审查人员不能被分派到该机构案件', () => {
  return scenario().then((ctx) => {
    assert.equal(mustRecuse(ctx.roster, 'R01', 'B01'), true);
    assert.equal(mustRecuse(ctx.roster, 'R02', 'B01'), false);
    assert.throws(
      () => assignCase(ctx.ledger, ctx.roster, 'CASE:RECUSE-B01', 'B01', ['R01', 'R03']),
      /依法回避/,
    );
  });
});

test('双人确认：单人意见不成立；两人一致才成立并留下当时规则版本', async () => {
  const ctx = await scenario();
  const caseRef = 'BANK:B08:INELIGIBLE';
  assignCase(ctx.ledger, ctx.roster, caseRef, 'B08', ['R03', 'R04']);
  const first = confirmDecision(ctx.ledger, ctx.roster, caseRef, 'R03', ACTIONS.EXCLUDE, '资格年审未通过', {
    rules_version: ctx.rules.rules_version,
    decided_at: '2026-09-21T08:35:00+08:00',
  });
  assert.equal(first.finalized, false);
  assert.equal(ctx.ledger.dispositions.has(caseRef), false);
  const second = confirmDecision(ctx.ledger, ctx.roster, caseRef, 'R04', ACTIONS.EXCLUDE, '同意剔除', {
    rules_version: ctx.rules.rules_version,
    decided_at: '2026-09-21T08:36:00+08:00',
  });
  assert.equal(second.finalized, true);
  const disposition = ctx.ledger.dispositions.get(caseRef);
  assert.equal(disposition.action, ACTIONS.EXCLUDE);
  assert.equal(disposition.rules_version, 'R2026-09-01');
  assert.equal(disposition.confirmations.length, 2);
});

test('两人意见不一致时决定不成立', async () => {
  const ctx = await scenario();
  const caseRef = 'ANOMALY:B05:5Y_PLUS:EV-005';
  assignCase(ctx.ledger, ctx.roster, caseRef, 'B05', ['R03', 'R04']);
  confirmDecision(ctx.ledger, ctx.roster, caseRef, 'R03', ACTIONS.EXCLUDE, '偏离过大', {
    rules_version: ctx.rules.rules_version,
  });
  const result = confirmDecision(ctx.ledger, ctx.roster, caseRef, 'R04', ACTIONS.CONFIRM_INCLUDE, '属市场变化', {
    rules_version: ctx.rules.rules_version,
  });
  assert.equal(result.finalized, false);
  assert.equal(result.status, 'disagreed');
  assert.equal(ctx.ledger.dispositions.has(caseRef), false);
});

test('处置全部阻断项与异常前不得冻结；法定数量不足时也阻断', async () => {
  const ctx = await scenario();
  const before = preFreezeCheck(ctx.ledger, ctx.rules, ctx.roster);
  assert.equal(before.can_freeze, false);
  assert.ok(before.unresolved_blockers.length >= 3);
  assert.equal(before.unresolved_anomalies.length, 3);
});

async function resolveAll() {
  const ctx = await scenario();
  const L = ctx.ledger;
  const rv = ctx.rules.rules_version;
  const decide = (caseRef, bankId, action, comment, pair) => {
    assignCase(L, ctx.roster, caseRef, bankId, pair);
    confirmDecision(L, ctx.roster, caseRef, pair[0], action, comment, { rules_version: rv });
    confirmDecision(L, ctx.roster, caseRef, pair[1], action, comment, { rules_version: rv });
  };
  // 无资格机构剔除（R01 与 B08 无关联）
  decide('BANK:B08:INELIGIBLE', 'B08', ACTIONS.EXCLUDE, '资格年审未通过，剔除该行全部报价', ['R01', 'R03']);
  // 重复报送以首次有效报送为准（R02 与 B02 关联，须回避）
  decide('EVENT:EV-007:DUPLICATE', 'B02', ACTIONS.IGNORE_DUPLICATE, '内容完全相同，以首次表格报送为准', ['R01', 'R03']);
  // B04 五年期缺报属实，逾期补报不纳入（R01 与 B04 无关联）
  decide('TENOR:B04:5Y_PLUS:MISSING', 'B04', ACTIONS.PROCEED_WITHOUT, '截止后补报不进入当期，按缺报处理', ['R03', 'R04']);
  // 异常报价经复核认定为市场变化，全部确认纳入
  decide('ANOMALY:B04:1Y:EV-004', 'B04', ACTIONS.CONFIRM_INCLUDE, '短端随政策利率上行，属市场变化', ['R02', 'R03']);
  decide('ANOMALY:B05:1Y:EV-005', 'B05', ACTIONS.CONFIRM_INCLUDE, '符合市场走势', ['R02', 'R03']);
  decide('ANOMALY:B05:5Y_PLUS:EV-005', 'B05', ACTIONS.CONFIRM_INCLUDE, '中长期需求偏强，依据说明充分', ['R03', 'R04']);
  return ctx;
}

test('全部事项双人处置后通过冻结检查，每期限纳入家数满足法定数量', async () => {
  const ctx = await resolveAll();
  const check = preFreezeCheck(ctx.ledger, ctx.rules, ctx.roster);
  assert.equal(check.can_freeze, true, JSON.stringify(check, null, 2));
  assert.equal(check.quorum['1Y'].included_count, 8);
  assert.equal(check.quorum['5Y_PLUS'].included_count, 7);
  assert.ok(check.quorum['1Y'].quorum_ok);
  assert.ok(check.quorum['5Y_PLUS'].quorum_ok);
});

test('冻结包完整列出纳入范围、排除理由、签署记录与规则快照', async () => {
  const ctx = await resolveAll();
  const frozenAt = '2026-09-21T08:55:00+08:00';
  const pkg = freezePackage(
    ctx.ledger,
    ctx.rules,
    ctx.roster,
    [
      { reviewer_id: 'R03', comment: '审查无误' },
      { reviewer_id: 'R04', comment: '同意冻结' },
    ],
    frozenAt,
  );
  assert.equal(pkg.rules_version, 'R2026-09-01');
  const oneY = pkg.tenors.find((t) => t.tenor === '1Y');
  const fiveY = pkg.tenors.find((t) => t.tenor === '5Y_PLUS');
  assert.equal(oneY.included_count, 8);
  assert.equal(fiveY.included_count, 7);
  // 逾期事件（EV-013、EV-014）与无资格机构均在排除清单中
  const reasons = pkg.exclusions.map((e) => e.reason_code);
  assert.ok(reasons.includes('AFTER_DEADLINE'));
  assert.ok(reasons.includes('INELIGIBLE_SUBMISSION'));
  assert.ok(reasons.includes('MISSING_WITH_LATE_SUPPLEMENT') === false);
  assert.ok(pkg.exclusions.some((e) => e.reason_code === 'LATE_SUPPLEMENT_EXCLUDED' && e.bank_id === 'B04'));
  // 每条双人决定均含两名签署人意见
  for (const exclusion of pkg.exclusions.filter((e) => e.decision)) {
    assert.equal(exclusion.decision.confirmations.length, 2);
    assert.equal(exclusion.decision.rules_version, 'R2026-09-01');
  }
  const signatures = pkg.signing_records.filter((r) => r.kind === 'FREEZE_SIGNATURE');
  assert.equal(signatures.length, 1);
  assert.equal(signatures[0].signers.length, 2);
  // 纳入条目保留来源与依据，可回溯到具体事件与版本
  const b01 = oneY.included.find((i) => i.bank_id === 'B01');
  assert.equal(b01.source_event, 'EV-006');
  assert.equal(b01.version_seq, 2);
  assert.ok(b01.data_basis.includes('中期借贷便利'));
});

test('冻结签署同样执行回避：关联审查人员不得签署冻结包', async () => {
  const ctx = await resolveAll();
  assert.throws(
    () =>
      freezePackage(
        ctx.ledger,
        ctx.rules,
        ctx.roster,
        [{ reviewer_id: 'R01' }, { reviewer_id: 'R03' }],
        '2026-09-21T08:55:00+08:00',
      ),
    /回避/,
  );
});

test('机构隔离视图：机构只能看到自身材料，看不到任何其他机构数据', async () => {
  const ctx = await scenario();
  const view = bankView(ctx.ledger, ctx.roster, ctx.rules, 'B01');
  assert.equal(view.viewer.bank_id, 'B01');
  const serialized = JSON.stringify(view);
  for (const other of ['B02', 'B04', 'B05', 'B08', 'B09']) {
    assert.ok(!serialized.includes(`"bank_id":"${other}"`), `视图中泄露了 ${other}`);
  }
  assert.ok(serialized.includes('EV-006'));
  // 可见自身修订理由
  assert.ok(view.versions.some((v) => (v.revision_reason ?? '').includes('中期借贷便利')));
});

test('审查人员视图：回避机构的报价数值对其脱敏，但不妨碍其他人处理', async () => {
  const ctx = await scenario();
  const r01View = reviewerView(ctx.ledger, ctx.roster, ctx.rules, 'R01');
  const b01Row = r01View.bank_statuses.find((r) => r.bank_id === 'B01');
  assert.equal(b01Row.recused_for_viewer, true);
  assert.equal(b01Row.perTenor['1Y'].redacted, true);
  assert.equal('value' in b01Row.perTenor['1Y'], false);
  // R03 与 B01 无关联，可见数值
  const r03View = reviewerView(ctx.ledger, ctx.roster, ctx.rules, 'R03');
  const b01ForR03 = r03View.bank_statuses.find((r) => r.bank_id === 'B01');
  assert.equal(b01ForR03.perTenor['1Y'].value, 3.05);
});
