// 当期报价报送审查规则。
// 规则以快照形式保存：冻结时把当时生效的规则完整写入冻结包，
// 事后复核按“当时规则”判断，而不是按后来修改过的规则。

export const TENOR_1Y = '1Y';
export const TENOR_5Y = '5Y+';

export const TENOR_LABELS = {
  [TENOR_1Y]: '一年期',
  [TENOR_5Y]: '五年期以上',
};

// 报送格式错误码，受理记录与冻结包中直接引用这些代码。
export const FORMAT_ERRORS = {
  TENOR_MISSING: 'TENOR_MISSING',
  TENOR_UNKNOWN: 'TENOR_UNKNOWN',
  VALUE_NOT_NUMBER: 'VALUE_NOT_NUMBER',
  UNIT_INVALID: 'UNIT_INVALID',
  VALUE_OUT_OF_RANGE: 'VALUE_OUT_OF_RANGE',
  VALUE_PRECISION: 'VALUE_PRECISION',
  SOURCE_REQUIRED: 'SOURCE_REQUIRED',
  REVISION_REASON_REQUIRED: 'REVISION_REASON_REQUIRED',
};

export function createRuleSnapshot(overrides = {}) {
  return {
    ruleSetId: 'lpr-submission-review-rules',
    // 规则版本随每期公布，冻结包记录该版本。
    version: '2026-09-01',
    tenors: [
      { code: TENOR_1Y, label: TENOR_LABELS[TENOR_1Y] },
      { code: TENOR_5Y, label: TENOR_LABELS[TENOR_5Y] },
    ],
    // 仅接受以百分数报送（如 3.10 表示 3.10%）。
    // 以基点（BP）或小数（0.031）报送均判为单位错误。
    valueUnit: 'percent',
    allowedUnits: ['percent'],
    precision: { decimals: 2, step: 0.05 },
    range: { exclusiveMin: 0, max: 20 },
    // 异常提示：以同期限全部当前报价的中位数为基准。
    // 报价步长为5个基点，提示阈值不宜低于一个步长的常见偏离。
    anomaly: { basis: 'median', warnRatio: 0.02, severeRatio: 0.05 },
    revision: {
      // 截止前更正：形成新版本，旧版本留痕。
      beforeDeadline: 'new-version-with-revision-reason',
      // 截止后补报：只登记备查，不进入当期计算。
      afterDeadline: 'register-only-not-in-current-cycle',
    },
    // 法定数量：名单内每家机构每个期限均应有有效报价，
    // 且每个期限实际纳入报价不得少于最低家数。
    quorum: { allRosterSlotsRequired: true, minIncludedPerTenor: 12 },
    // 剔除、恢复、作废均须两名互不相同且无利害关系的审核员确认。
    dualConfirmation: true,
    conflictPolicy: 'reviewer-affiliated-with-institution-must-recuse',
    ...overrides,
  };
}

function approximatelyEqual(a, b, epsilon = 1e-9) {
  return Math.abs(a - b) <= epsilon;
}

// 校验单条报价的格式，返回错误码数组；空数组表示格式通过。
// 不涉及报送窗口、资格与重复判定，那些由审查会话处理。
export function validateQuoteFormat(submission, rule) {
  const errors = [];
  const tenorCodes = new Set(rule.tenors.map((tenor) => tenor.code));

  if (submission.tenor === undefined || submission.tenor === null || submission.tenor === '') {
    errors.push(FORMAT_ERRORS.TENOR_MISSING);
  } else if (!tenorCodes.has(submission.tenor)) {
    errors.push(FORMAT_ERRORS.TENOR_UNKNOWN);
  }

  const value = submission.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(FORMAT_ERRORS.VALUE_NOT_NUMBER);
  } else {
    if (value <= rule.range.exclusiveMin || value > rule.range.max) {
      errors.push(FORMAT_ERRORS.VALUE_OUT_OF_RANGE);
    }
    const scaled = value / rule.precision.step;
    if (
      !approximatelyEqual(scaled, Math.round(scaled)) ||
      !approximatelyEqual(value, Number(value.toFixed(rule.precision.decimals)))
    ) {
      errors.push(FORMAT_ERRORS.VALUE_PRECISION);
    }
  }

  if (!rule.allowedUnits.includes(submission.unit)) {
    errors.push(FORMAT_ERRORS.UNIT_INVALID);
  }

  if (typeof submission.sourceDescription !== 'string' || submission.sourceDescription.trim() === '') {
    errors.push(FORMAT_ERRORS.SOURCE_REQUIRED);
  }

  return errors;
}

export function median(values, decimals = 10) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const raw = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  const factor = 10 ** decimals;
  return Math.round((raw + Number.EPSILON) * factor) / factor;
}
