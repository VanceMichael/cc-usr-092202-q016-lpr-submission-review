// 异常提示：区分“市场变化”与“口径错误”，异常只提示、不自动剔除。
import { basisPoints } from './rules.js';
import { bankStatuses, effectiveQuote } from './store.js';

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// 对每个期限的有效报价计算偏离，返回需要复核的提示清单。
export function detectAnomalies(ledger, rules, roster) {
  const anomalies = [];
  const statuses = bankStatuses(ledger, rules, roster);
  for (const tenor of rules.tenors) {
    const validRows = statuses
      .filter((row) => row.qualified && row.perTenor[tenor.code]?.state === 'valid')
      .map((row) => ({ bank_id: row.bank_id, bank_name: row.bank_name, ...row.perTenor[tenor.code] }));
    const values = validRows.map((row) => row.value);
    const med = values.length > 0 ? median(values) : null;
    const previous = rules.previous_publish?.[tenor.code];

    for (const row of validRows) {
      const reasons = [];
      if (typeof previous === 'number') {
        const diff = basisPoints(row.value, previous);
        if (diff > (rules.anomaly?.vs_previous_max_bp ?? Infinity)) {
          reasons.push({
            code: 'DEVIATION_FROM_PREVIOUS',
            detail: `较上一期公布值 ${previous}% 偏离 ${diff} 个基点，超过阈值 ${rules.anomaly.vs_previous_max_bp} 个基点`,
            bp: diff,
          });
        }
      }
      if (med !== null && values.length >= 3) {
        const diff = basisPoints(row.value, med);
        if (diff > (rules.anomaly?.vs_median_max_bp ?? Infinity)) {
          reasons.push({
            code: 'DEVIATION_FROM_MEDIAN',
            detail: `较当期有效报价中位数 ${med}% 偏离 ${diff} 个基点，超过阈值 ${rules.anomaly.vs_median_max_bp} 个基点`,
            bp: diff,
          });
        }
      }
      if (reasons.length > 0) {
        const effective = effectiveQuote(ledger, row.bank_id, tenor.code);
        anomalies.push({
          code: 'ANOMALOUS_QUOTE',
          bank_id: row.bank_id,
          bank_name: row.bank_name,
          tenor: tenor.code,
          tenor_label: tenor.label,
          event_id: row.event_id,
          value: row.value,
          reasons,
          case_ref: `ANOMALY:${row.bank_id}:${tenor.code}:${row.event_id}`,
          data_basis: effective?.version.data_basis ?? '',
        });
      }
    }
  }
  return anomalies;
}
