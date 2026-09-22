// 报价期规则：窗口、期限品种、数值口径与异常阈值。
// 所有审查结论都必须引用 rules_version，确保“留下当时规则”。

export function loadRules(raw) {
  const rules = typeof raw === 'string' ? JSON.parse(raw) : raw;
  for (const field of ['period_id', 'rules_version', 'window_open', 'deadline', 'tenors']) {
    if (!rules[field]) {
      throw new Error(`报价期规则缺少必要字段: ${field}`);
    }
  }
  if (!Array.isArray(rules.tenors) || rules.tenors.length === 0) {
    throw new Error('报价期规则至少需要一个期限品种');
  }
  const tenorCodes = new Set();
  for (const tenor of rules.tenors) {
    if (!tenor.code || !tenor.label || tenor.unit !== 'percent') {
      throw new Error('期限品种定义无效：需包含代码、标签且单位为 percent');
    }
    if (tenorCodes.has(tenor.code)) {
      throw new Error(`期限品种重复: ${tenor.code}`);
    }
    tenorCodes.add(tenor.code);
    if (!(tenor.step > 0) || !(tenor.min < tenor.max)) {
      throw new Error(`期限 ${tenor.code} 的步长或取值区间无效`);
    }
  }
  if (new Date(rules.deadline) <= new Date(rules.window_open)) {
    throw new Error('报送截止时间必须晚于窗口开启时间');
  }
  return rules;
}

export function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// 以基点为单位的偏离量（百分数口径：0.01 个百分点 = 1 个基点）。
export function basisPoints(a, b) {
  return Math.round(Math.abs(a - b) * 10000) / 100;
}

// 事件相对报送窗口的归类：截止（含）前为窗口内，之后一律逾期。
export function classifyTimeliness(event, rules) {
  const received = new Date(event.received_at).getTime();
  if (Number.isNaN(received)) {
    throw new Error(`报送事件 ${event.id} 时间格式无效`);
  }
  if (received <= new Date(rules.deadline).getTime()) {
    return 'on_time';
  }
  return 'late';
}

function tenorRulesOf(rules, tenorCode) {
  return rules.tenors.find((tenor) => tenor.code === tenorCode) || null;
}

// 对单个报价数值做格式校验，错误代码可供阻断冻结与分派复核直接引用。
// - NOT_NUMBER   无法识别为数值
// - UNKNOWN_TENOR 期限品种不在本期规则内
// - OUT_OF_RANGE 超出规则允许区间
// - BAD_STEP     不符合最小报价单位
// - UNIT_DECIMAL_RATIO 误按小数比例填报（如 0.0305 应为 3.05）
// - UNIT_BASIS_POINTS  误按基点填报（如 305 应为 3.05）
export function validateQuote(value, tenorCode, rules) {
  const errors = [];
  const tenor = tenorRulesOf(rules, tenorCode);
  if (!tenor) {
    return { ok: false, errors: [{ code: 'UNKNOWN_TENOR', message: `未知期限品种: ${tenorCode}` }] };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, errors: [{ code: 'NOT_NUMBER', message: '报价不是有效数值' }] };
  }
  const heuristic = rules.unit_heuristics || {};
  if (value > 0 && value < (heuristic.decimal_ratio_max ?? 0.5)) {
    errors.push({
      code: 'UNIT_DECIMAL_RATIO',
      message: `报价 ${value} 小于 ${heuristic.decimal_ratio_max ?? 0.5}，疑似误按小数比例报送，应为 ${round2(value * 100)}（百分数口径）`,
    });
  }
  if (value >= (heuristic.basis_points_min ?? 20)) {
    errors.push({
      code: 'UNIT_BASIS_POINTS',
      message: `报价 ${value} 不小于 ${heuristic.basis_points_min ?? 20}，疑似误按基点报送，应为 ${round2(value / 100)}（百分数口径）`,
    });
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  if (value < tenor.min || value > tenor.max) {
    errors.push({
      code: 'OUT_OF_RANGE',
      message: `报价 ${value} 超出 ${tenor.label} 允许区间 [${tenor.min}, ${tenor.max}]`,
    });
  }
  const ticks = Math.round(value / tenor.step);
  if (Math.abs(ticks * tenor.step - value) > 1e-9) {
    errors.push({
      code: 'BAD_STEP',
      message: `报价 ${value} 不符合最小变动单位 ${tenor.step}`,
    });
  }
  return { ok: errors.length === 0, errors };
}
