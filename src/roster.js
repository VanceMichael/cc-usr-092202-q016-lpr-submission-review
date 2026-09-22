// 机构资格与回避关系名册。
export function loadRoster(raw) {
  const roster = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(roster.banks) || !Array.isArray(roster.reviewers)) {
    throw new Error('名册缺少 banks 或 reviewers');
  }
  const banks = new Map();
  for (const bank of roster.banks) {
    if (!bank.id || !bank.name || banks.has(bank.id)) {
      throw new Error(`机构名册条目无效或重复: ${bank.id}`);
    }
    banks.set(bank.id, { qualified: true, conflicted_reviewer: null, ...bank });
  }
  const reviewers = new Map();
  for (const reviewer of roster.reviewers) {
    if (!reviewer.id || !reviewer.name || reviewers.has(reviewer.id)) {
      throw new Error(`审查人员名册条目无效或重复: ${reviewer.id}`);
    }
    reviewers.set(reviewer.id, reviewer);
  }
  for (const bank of banks.values()) {
    if (bank.conflicted_reviewer && !reviewers.has(bank.conflicted_reviewer)) {
      throw new Error(`机构 ${bank.id} 配置的回避人员 ${bank.conflicted_reviewer} 不存在`);
    }
  }
  return { ...roster, banks, reviewers };
}

export function isQualified(roster, bankId) {
  const bank = roster.banks.get(bankId);
  return Boolean(bank && bank.qualified);
}

// 审查人员对某机构是否需要回避。
export function mustRecuse(roster, reviewerId, bankId) {
  const bank = roster.banks.get(bankId);
  if (!bank || !roster.reviewers.has(reviewerId)) {
    throw new Error('机构或审查人员不存在，无法判定回避关系');
  }
  return bank.conflicted_reviewer === reviewerId;
}
