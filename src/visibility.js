// 视图隔离：机构账号只能查看自身材料，看不到其他机构的任何报送、更正或审查信息。
// 审查人员在其权限范围内可见，但回避机构的案件细节对其脱敏。
import { bankStatuses } from './store.js';

function sanitizeVersion(version) {
  return {
    seq: version.seq,
    event_id: version.event_id,
    received_at: version.received_at,
    source: version.source,
    data_basis: version.data_basis,
    revision_reason: version.revision_reason,
    is_correction: version.is_correction,
    timeliness: version.timeliness,
    status: version.status,
    quotes: version.quotes.map((quote) => ({
      tenor: quote.tenor,
      value: quote.value,
      valid: quote.validation.ok,
      errors: quote.validation.ok ? [] : quote.validation.errors.map((error) => ({ code: error.code, message: error.message })),
    })),
  };
}

// 机构视图：只包含本机构各版本、自身阻断项与对本机构案件的最终结论。
export function bankView(ledger, roster, rules, bankId) {
  const bank = roster.banks.get(bankId);
  if (!bank) {
    throw new Error(`机构不在名册: ${bankId}`);
  }
  const versions = (ledger.versionsByBank.get(bankId) ?? []).map(sanitizeVersion);
  const statusRow = bankStatuses(ledger, rules, roster).find((row) => row.bank_id === bankId);
  const myCases = [...ledger.dispositions.values()]
    .filter((disposition) => disposition.bank_id === bankId)
    .map((disposition) => ({
      case_ref: disposition.case_ref,
      action: disposition.action,
      rules_version: disposition.rules_version,
      decided_at: disposition.decided_at,
      // 向机构反馈结论与理由，但不展示内部审查人员姓名以外的分派细节。
      confirmations: disposition.confirmations.map((item) => ({
        reviewer_name: item.reviewer_name,
        comment: item.comment,
        decided_at: item.decided_at,
      })),
    }));
  return {
    viewer: { kind: 'BANK', bank_id: bankId, bank_name: bank.name },
    period_id: rules.period_id,
    qualified: bank.qualified,
    versions,
    current_status: statusRow?.perTenor ?? {},
    review_decisions: myCases,
  };
}

// 审查人员视图：可见全部案件，但本人须回避机构的报价数值与报送依据被脱敏。
export function reviewerView(ledger, roster, rules, reviewerId) {
  if (!roster.reviewers.has(reviewerId)) {
    throw new Error(`审查人员不在名册: ${reviewerId}`);
  }
  const statuses = bankStatuses(ledger, rules, roster).map((row) => {
    const recused = roster.banks.get(row.bank_id).conflicted_reviewer === reviewerId;
    if (!recused) {
      return row;
    }
    return {
      ...row,
      recused_for_viewer: true,
      perTenor: Object.fromEntries(
        Object.entries(row.perTenor).map(([tenor, state]) => [
          tenor,
          state.state === 'valid' ? { state: 'valid', redacted: true } : state,
        ]),
      ),
    };
  });
  return {
    viewer: { kind: 'REVIEWER', reviewer_id: reviewerId, reviewer_name: roster.reviewers.get(reviewerId).name },
    period_id: rules.period_id,
    bank_statuses: statuses,
    cases: [...ledger.reviews.values()].map((item) => {
      const recused = roster.banks.get(item.bank_id).conflicted_reviewer === reviewerId;
      return {
        case_ref: item.case_ref,
        bank_id: item.bank_id,
        status: item.status,
        assignees: item.assignees,
        recused_for_viewer: recused,
        final_action: item.final_action,
      };
    }),
  };
}
