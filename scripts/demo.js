// 端到端演示：回放 2026-09 期报送样例，展示
// 接收校验 → 阻断项/异常提示 → 回避分派 → 双人确认 → 冻结 → 隔离视图 的完整过程。
// 运行：node scripts/demo.js
import { readFile } from 'node:fs/promises';
import {
  buildLedger,
  freezeBlockers,
  detectAnomalies,
  assignCase,
  confirmDecision,
  preFreezeCheck,
  freezePackage,
  bankView,
  ACTIONS,
} from '../src/index.js';

const read = (name) => readFile(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const line = () => console.log('─'.repeat(72));

function heading(title) {
  console.log(`\n${title}\n${'═'.repeat(72)}`);
}

const statusLabel = {
  accepted: '有效版本',
  invalid: '格式/单位错误',
  duplicate: '重复报送',
  late: '截止后(逾期登记)',
  ineligible: '无资格机构',
};

const { rules, roster, ledger, receipts } = buildLedger(
  await read('period-2026-09.json'),
  await read('roster.json'),
  await read('submissions-2026-09.json'),
);

heading(`报价期 ${rules.period_id}（规则版本 ${rules.rules_version}）报送接收台账`);
console.log('报送窗口：', rules.window_open, '→ 截止', rules.deadline);
for (const [bankId, versions] of [...ledger.versionsByBank].sort()) {
  const bank = roster.banks.get(bankId);
  console.log(`\n${bankId} ${bank.name}（${versions.length} 个版本）`);
  for (const v of versions) {
    const quotes = v.quotes
      .map((q) => {
        const tag = q.validation.ok ? '' : ` ⚠${q.validation.errors.map((e) => e.code).join(',')}`;
        return `${q.tenor}=${q.value}${tag}`;
      })
      .join('  ');
    console.log(
      `  v${v.seq} ${v.received_at} [${v.source}]${v.is_correction ? ' 更正' : ''} ` +
        `${statusLabel[v.status]}  ${quotes}  事件${v.event_id}`,
    );
  }
}

heading('冻结阻断项（缺报 / 重复 / 单位错误 / 无资格）');
for (const blocker of freezeBlockers(ledger, rules, roster)) {
  console.log(`✋ [${blocker.code}] ${blocker.message}（案件 ${blocker.case_ref}）`);
}

heading('异常提示（仅提示，不自动剔除——需人工判断市场变化还是口径错误）');
for (const anomaly of detectAnomalies(ledger, rules, roster)) {
  console.log(
    `? [${anomaly.bank_id} ${anomaly.tenor_label} ${anomaly.value}%] ${anomaly.reasons
      .map((r) => r.detail)
      .join('；')}（案件 ${anomaly.case_ref}）`,
  );
  console.log(`    机构依据：${anomaly.data_basis}`);
}

heading('回避分派');
try {
  assignCase(ledger, roster, 'DEMO:ILLEGAL', 'B01', ['R01', 'R03']);
} catch (error) {
  console.log(`系统拒绝把 B01 案件分给 R01：${error.message}`);
}
console.log('自动分派 B01 案件 →', assignCase(ledger, roster, 'DEMO:B01-ASSIGN', 'B01').assignees.join('、'), '（R01 已自动排除）');

heading('双人确认处置（每条决定记录动作、意见与规则版本）');
const rv = rules.rules_version;
const decide = (caseRef, bankId, action, comment, pair) => {
  if (!ledger.reviews.has(caseRef)) {
    assignCase(ledger, roster, caseRef, bankId, pair);
  }
  confirmDecision(ledger, roster, caseRef, pair[0], action, comment, { rules_version: rv });
  confirmDecision(ledger, roster, caseRef, pair[1], action, comment, { rules_version: rv });
  console.log(`✓ ${caseRef} → ${action}（${pair.join('、')} 一致确认，依据规则 ${rv}）`);
};
decide('BANK:B08:INELIGIBLE', 'B08', ACTIONS.EXCLUDE, '资格年审未通过，剔除该行全部报价', ['R01', 'R03']);
decide('EVENT:EV-007:DUPLICATE', 'B02', ACTIONS.IGNORE_DUPLICATE, '内容完全相同，以首次表格报送为准', ['R01', 'R03']);
decide('TENOR:B04:5Y_PLUS:MISSING', 'B04', ACTIONS.PROCEED_WITHOUT, '截止后补报不进入当期，按缺报处理', ['R03', 'R04']);
decide('ANOMALY:B04:1Y:EV-004', 'B04', ACTIONS.CONFIRM_INCLUDE, '短端随政策利率上行，属市场变化', ['R02', 'R03']);
decide('ANOMALY:B05:1Y:EV-005', 'B05', ACTIONS.CONFIRM_INCLUDE, '符合市场走势', ['R02', 'R03']);
decide('ANOMALY:B05:5Y_PLUS:EV-005', 'B05', ACTIONS.CONFIRM_INCLUDE, '中长期需求偏强，依据说明充分', ['R03', 'R04']);

heading('冻结前检查');
const check = preFreezeCheck(ledger, rules, roster);
for (const [code, q] of Object.entries(check.quorum)) {
  console.log(`${code}：纳入 ${q.included_count} 家（法定最少 ${q.min_required} 家）→ ${q.quorum_ok ? '达标' : '不足'}`);
}
console.log(check.can_freeze ? '全部阻断项与异常已处置，可以冻结。' : '仍有未决事项，禁止冻结。');

heading('生成冻结包（双人签署：R03 林策、R04 顾行之）');
const pkg = freezePackage(
  ledger,
  rules,
  roster,
  [
    { reviewer_id: 'R03', comment: '审查过程完整，同意冻结' },
    { reviewer_id: 'R04', comment: '同意冻结，规则版本与决定记录核对一致' },
  ],
  '2026-09-21T08:55:00+08:00',
);
console.log('冻结包编号：', pkg.package_id);
for (const tenor of pkg.tenors) {
  console.log(`\n【${tenor.tenor_label}】纳入 ${tenor.included_count} 家：`);
  for (const item of tenor.included) {
    const flag = item.anomaly_case ? ' (异常已复核纳入)' : '';
    console.log(`  ${item.bank_id} ${item.bank_name}  ${item.value}%  ← 事件${item.source_event}/v${item.version_seq} [${item.source}]${flag}`);
  }
}
console.log('\n排除清单：');
for (const exclusion of pkg.exclusions) {
  const scope = exclusion.tenor ? `${exclusion.tenor} ` : '';
  const decision = exclusion.decision ? `双人决定 ${exclusion.decision.confirmations.map((c) => c.reviewer_name).join('、')}` : '系统规则自动留痕';
  console.log(`  [${exclusion.reason_code}] ${exclusion.bank_id} ${scope}：${exclusion.reason}（${decision}）`);
}
console.log('\n签署记录：');
for (const record of pkg.signing_records) {
  if (record.kind === 'FREEZE_SIGNATURE') {
    for (const signer of record.signers) {
      console.log(`  冻结签署 ${signer.reviewer_id} ${signer.reviewer_name}：${signer.comment}`);
    }
  } else {
    console.log(`  案件签署 ${record.case_ref} → ${record.action}（${record.confirmations.map((c) => c.reviewer_name).join('、')}）`);
  }
}

heading('机构隔离视图（B01 华信银行登录后所见）');
const view = bankView(ledger, roster, rules, 'B01');
console.log('登录机构：', view.viewer.bank_id, view.viewer.bank_name);
for (const v of view.versions) {
  console.log(`  v${v.seq} ${v.received_at} ${statusLabel[v.status]}`);
  for (const q of v.quotes) {
    console.log(`    ${q.tenor} ${q.value} ${q.valid ? '校验通过' : q.errors.map((e) => e.message).join('；')}`);
  }
  if (v.revision_reason) {
    console.log(`    修订理由：${v.revision_reason}`);
  }
}
console.log('  对本机构的审查结论：', view.review_decisions.length ? `${view.review_decisions.length} 条` : '无');
console.log('（视图中不含任何其他机构的报价、事件或审查信息）');
line();
