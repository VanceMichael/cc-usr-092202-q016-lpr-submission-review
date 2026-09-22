// 回避分派与双人复核：
// - 与机构有关联的审查人员不得参与该机构任何审查动作；
// - 剔除、恢复等决定必须由两名不同的审查人员作出相同确认；
// - 决定成立时记录当时规则版本，规则日后调整也不改变历史结论。
import { mustRecuse } from './roster.js';

export const ACTIONS = Object.freeze({
  EXCLUDE: 'EXCLUDE', // 剔除（无资格机构、异常报价等）
  RESTORE: 'RESTORE', // 恢复纳入
  CONFIRM_INCLUDE: 'CONFIRM_INCLUDE', // 异常经复核确认属市场变化，纳入
  CONFIRM_EXCLUDED: 'CONFIRM_EXCLUDED', // 确认逾期报送不纳入当期
  IGNORE_DUPLICATE: 'IGNORE_DUPLICATE', // 重复报送仅登记，以原件为准
  PROCEED_WITHOUT: 'PROCEED_WITHOUT', // 缺报属实，该机构该期限不参与当期
});

// 自动挑选两名无需回避的审查人员；也允许显式指定（仍会强制校验回避）。
export function assignCase(ledger, roster, caseRef, bankId, preferredAssignees = null) {
  if (!roster.banks.has(bankId)) {
    throw new Error(`分派目标机构不存在: ${bankId}`);
  }
  if (ledger.reviews.has(caseRef)) {
    throw new Error(`审查案件已分派: ${caseRef}`);
  }
  let assignees = preferredAssignees;
  if (!assignees) {
    assignees = [...roster.reviewers.keys()]
      .filter((reviewerId) => !mustRecuse(roster, reviewerId, bankId))
      .slice(0, 2);
  }
  if (!assignees || assignees.length !== 2 || new Set(assignees).size !== 2) {
    throw new Error(`案件 ${caseRef} 必须分派给两名不同的审查人员`);
  }
  for (const reviewerId of assignees) {
    if (!roster.reviewers.has(reviewerId)) {
      throw new Error(`审查人员不存在: ${reviewerId}`);
    }
    if (mustRecuse(roster, reviewerId, bankId)) {
      throw new Error(`审查人员 ${reviewerId} 与机构 ${bankId} 存在关联，依法回避不得分派`);
    }
  }
  const reviewCase = {
    case_ref: caseRef,
    bank_id: bankId,
    assignees,
    status: 'open',
    confirmations: [],
    final_action: null,
    opened_at: null,
  };
  ledger.reviews.set(caseRef, reviewCase);
  return reviewCase;
}

// 审查人员给出确认意见。两人一致时决定成立并写入处置台账。
export function confirmDecision(ledger, roster, caseRef, reviewerId, action, comment, context = {}) {
  const reviewCase = ledger.reviews.get(caseRef);
  if (!reviewCase) {
    throw new Error(`审查案件不存在或未分派: ${caseRef}`);
  }
  if (reviewCase.status === 'finalized') {
    throw new Error(`案件 ${caseRef} 已作出决定，不得更改（恢复须另立案件）`);
  }
  if (!reviewCase.assignees.includes(reviewerId)) {
    throw new Error(`审查人员 ${reviewerId} 未被分派案件 ${caseRef}`);
  }
  if (mustRecuse(roster, reviewerId, reviewCase.bank_id)) {
    throw new Error(`审查人员 ${reviewerId} 须回避机构 ${reviewCase.bank_id} 的审查`);
  }
  if (!Object.values(ACTIONS).includes(action)) {
    throw new Error(`未知审查动作: ${action}`);
  }
  if (reviewCase.confirmations.some((item) => item.reviewer_id === reviewerId)) {
    throw new Error(`审查人员 ${reviewerId} 已对案件 ${caseRef} 表达过意见`);
  }

  reviewCase.confirmations.push({
    reviewer_id: reviewerId,
    reviewer_name: roster.reviewers.get(reviewerId).name,
    action,
    comment: String(comment ?? ''),
    decided_at: context.decided_at ?? new Date().toISOString(),
    rules_version: context.rules_version,
  });

  if (reviewCase.confirmations.length === 2) {
    const [first, second] = reviewCase.confirmations;
    if (first.action !== second.action) {
      reviewCase.status = 'disagreed';
      return { finalized: false, status: 'disagreed', reviewCase };
    }
    reviewCase.status = 'finalized';
    reviewCase.final_action = action;
    ledger.dispositions.set(caseRef, {
      case_ref: caseRef,
      bank_id: reviewCase.bank_id,
      action,
      rules_version: second.rules_version,
      decided_at: second.decided_at,
      confirmations: reviewCase.confirmations.map(({ reviewer_id, reviewer_name, action: act, comment: c, decided_at, rules_version }) => ({
        reviewer_id,
        reviewer_name,
        action: act,
        comment: c,
        decided_at,
        rules_version,
      })),
    });
    return { finalized: true, status: 'finalized', action, reviewCase };
  }
  return { finalized: false, status: 'awaiting_second', reviewCase };
}

// 意见不一致时重开案件，由原分派人员重新表决（记录保留分歧痕迹）。
export function reopenDisagreed(ledger, caseRef) {
  const reviewCase = ledger.reviews.get(caseRef);
  if (!reviewCase || reviewCase.status !== 'disagreed') {
    throw new Error(`案件 ${caseRef} 不处于分歧状态，无需重开`);
  }
  reviewCase.status = 'open';
  reviewCase.confirmations = [];
  return reviewCase;
}
