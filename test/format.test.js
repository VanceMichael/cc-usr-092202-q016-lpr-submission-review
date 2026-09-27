import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuleSnapshot,
  validateQuoteFormat,
  median,
  FORMAT_ERRORS,
} from '../src/rules.js';

const rule = createRuleSnapshot();

function quote(overrides = {}) {
  return {
    institutionId: 'BANK01',
    tenor: '1Y',
    value: 3.1,
    unit: 'percent',
    sourceDescription: '行内报价模型输出',
    ...overrides,
  };
}

test('合规百分数报价通过格式校验', () => {
  assert.deepEqual(validateQuoteFormat(quote(), rule), []);
  assert.deepEqual(validateQuoteFormat(quote({ tenor: '5Y+', value: 3.6 }), rule), []);
});

test('以基点报送判为单位错误', () => {
  const errors = validateQuoteFormat(quote({ value: 310, unit: 'bp' }), rule);
  assert.ok(errors.includes(FORMAT_ERRORS.UNIT_INVALID));
});

test('小数口径与错误步长判为精度错误', () => {
  assert.ok(
    validateQuoteFormat(quote({ value: 0.031 }), rule).includes(FORMAT_ERRORS.VALUE_PRECISION),
  );
  assert.ok(
    validateQuoteFormat(quote({ value: 3.07 }), rule).includes(FORMAT_ERRORS.VALUE_PRECISION),
  );
  assert.ok(
    validateQuoteFormat(quote({ value: 3.101 }), rule).includes(FORMAT_ERRORS.VALUE_PRECISION),
  );
});

test('期限缺失或无法识别', () => {
  assert.ok(
    validateQuoteFormat(quote({ tenor: undefined }), rule).includes(FORMAT_ERRORS.TENOR_MISSING),
  );
  assert.ok(
    validateQuoteFormat(quote({ tenor: '2Y' }), rule).includes(FORMAT_ERRORS.TENOR_UNKNOWN),
  );
});

test('数值非数字、越界与来源缺失', () => {
  assert.ok(
    validateQuoteFormat(quote({ value: '3.10' }), rule).includes(FORMAT_ERRORS.VALUE_NOT_NUMBER),
  );
  assert.ok(
    validateQuoteFormat(quote({ value: 0 }), rule).includes(FORMAT_ERRORS.VALUE_OUT_OF_RANGE),
  );
  assert.ok(
    validateQuoteFormat(quote({ value: -1 }), rule).includes(FORMAT_ERRORS.VALUE_OUT_OF_RANGE),
  );
  assert.ok(
    validateQuoteFormat(quote({ value: 25 }), rule).includes(FORMAT_ERRORS.VALUE_OUT_OF_RANGE),
  );
  assert.ok(
    validateQuoteFormat(quote({ sourceDescription: '   ' }), rule).includes(
      FORMAT_ERRORS.SOURCE_REQUIRED,
    ),
  );
});

test('中位数计算', () => {
  assert.equal(median([3.2, 3.1, 3.1, 3.85]), 3.15);
  assert.equal(median([3.1, 3.1, 3.1]), 3.1);
});
