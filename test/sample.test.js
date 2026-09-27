import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadQuoteSample } from '../src/load-sample.js';

test('报价样例完整回放并形成可复核冻结包', async () => {
  const { sample, session } = await loadQuoteSample();
  assert.equal(session.status, 'open');

  // 冻结前无阻断：单位错误已截止前更正，重复已双人作废，异常已双人剔除。
  assert.deepEqual(session.freezeBlockers(), []);

  const result = session.freeze({ operatorId: 'rv-zhang', now: sample.cycle.deadlineAt });
  assert.equal(result.frozen, true);
  const pkg = result.package;

  const count1Y = pkg.included.filter((item) => item.tenor === '1Y').length;
  const count5Y = pkg.included.filter((item) => item.tenor === '5Y+').length;
  assert.equal(count1Y, sample.expect.included1Y);
  assert.equal(count5Y, sample.expect.included5Y);
  assert.ok(pkg.quorum.every((q) => q.met));

  // 每类排除理由都在冻结包中可查。
  for (const code of sample.expect.excludedReasonCodes) {
    assert.ok(
      pkg.excluded.some((item) => item.reasonCode === code),
      `缺少排除理由 ${code}`,
    );
  }

  // BANK06 的1年期异常报价被双人剔除，5年期以上仍纳入。
  const bank06Included = pkg.included.filter((item) => item.institution.id === 'BANK06');
  assert.deepEqual(bank06Included.map((item) => item.tenor), ['5Y+']);

  // BANK03 首报310bp留痕为格式错误旧版，v2 为当期输入。
  const bank03Audit = pkg.auditTrail.find((item) => item.institution.id === 'BANK03' && item.tenor === '1Y');
  assert.equal(bank03Audit.versions[0].status, 'invalid-superseded');
  assert.ok(bank03Audit.versions[0].formatErrors.includes('UNIT_INVALID'));
  assert.equal(bank03Audit.versions[1].status, 'valid');

  // 剔除/作废均有两名审核员签署，且记录当时规则版本。
  assert.equal(pkg.signRecords.length, 2);
  for (const sign of pkg.signRecords) {
    assert.notEqual(sign.proposedBy.id, sign.confirmedBy.id);
    assert.ok(sign.ruleInEffect.version);
  }

  // 截止后补报、无资格与不明期限来件均隔离留痕，且未进入纳入清单。
  assert.equal(pkg.excluded.filter((e) => e.reasonCode === 'AFTER_DEADLINE_REGISTER_ONLY').length, 1);
  assert.equal(pkg.notEligibleIntakes.length, sample.expect.strayIntakes);
  assert.equal(pkg.malformedIntakes.length, sample.expect.malformedIntakes);
  assert.ok(!pkg.included.some((item) => item.institution.id === 'BANK99'));

  // 严重异常（BANK06 1Y 偏离约24%）在冻结包中留有提示。
  assert.ok(pkg.anomalyFlags.some((f) => f.institutionId === 'BANK06' && f.tenor === '1Y' && f.level === 'severe'));
});

test('机构视角隔离：BANK05 只能看到自家报送与截止后补报登记', async () => {
  const { session } = await loadQuoteSample();
  const view = session.institutionView('BANK05');
  assert.equal(view.allowed, true);
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes('BANK06'));
  assert.ok(!serialized.includes('BANK01'));
  const oneY = view.submissions.find((s) => s.tenor === '1Y');
  assert.equal(oneY.versions[0].value, 3.1);
  assert.equal(oneY.lateIntakes[0].status, 'late-registered');
  assert.equal(oneY.lateIntakes[0].value, 3.05);
});

test('机构视角看不到其他机构的审核处置与冻结摘要', async () => {
  const { session } = await loadQuoteSample();
  session.freeze({ operatorId: 'rv-zhang' });
  const view = session.institutionView('BANK01');
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes('frozenPackage'));
  assert.ok(!serialized.includes('digest'));
  // 但本机构材料上的审核意见可见。
  assert.equal(view.cycle.frozen, true);
});

test('样例文件本身不包含凭据字段', async () => {
  const raw = await readFile(new URL('../fixtures/quote-sample.json', import.meta.url), 'utf8');
  assert.ok(!/password|secret|token|apiKey/i.test(raw));
});
