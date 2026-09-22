// 统一入口：从期次规则、名册与原始报送事件构建审查台账。
import { loadRules } from './rules.js';
import { loadRoster } from './roster.js';
import { createLedger, ingestEvent } from './store.js';

export * from './rules.js';
export * from './roster.js';
export * from './store.js';
export * from './anomaly.js';
export * from './review.js';
export * from './freeze.js';
export * from './visibility.js';

// 按接收时间顺序回放事件（样例本身已排序，这里再保证一次），构建台账。
export function buildLedger(rulesRaw, rosterRaw, submissionsRaw) {
  const rules = loadRules(rulesRaw);
  const roster = loadRoster(rosterRaw);
  const submissions = typeof submissionsRaw === 'string' ? JSON.parse(submissionsRaw) : submissionsRaw;
  if (submissions.period_id !== rules.period_id) {
    throw new Error('报送事件与报价期不匹配');
  }
  const ledger = createLedger(rules.period_id);
  const events = [...submissions.events].sort(
    (a, b) => new Date(a.received_at).getTime() - new Date(b.received_at).getTime(),
  );
  const receipts = events.map((event) => ingestEvent(ledger, rules, roster, event));
  return { rules, roster, ledger, receipts };
}
