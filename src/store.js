// 报送台账：原始事件只追加、不改写；据此生成版本、标记与阻断项。
import { classifyTimeliness, validateQuote } from './rules.js';
import { isQualified } from './roster.js';

export function createLedger(periodId) {
  return {
    period_id: periodId,
    events: [],
    // bankId -> 版本数组（含逾期与重复登记，状态字段区分）
    versionsByBank: new Map(),
    dispositions: new Map(),
    reviews: new Map(),
  };
}

function quoteKey(quotes) {
  return [...quotes]
    .map((quote) => `${quote.tenor}=${quote.value}`)
    .sort()
    .join('|');
}

function isDuplicateOf(version, quotes) {
  if (version.status !== 'accepted' && version.status !== 'invalid') {
    return false;
  }
  return version.quotes.length === quotes.length && quoteKey(version.quotes) === quoteKey(quotes);
}

// 接收一条原始报送事件，返回登记结果。重复与逾期都会登记，但不会成为当期有效版本。
export function ingestEvent(ledger, rules, roster, event) {
  if (event.period_id && event.period_id !== rules.period_id) {
    throw new Error(`事件 ${event.id} 不属于报价期 ${rules.period_id}`);
  }
  if (ledger.events.some((known) => known.id === event.id)) {
    throw new Error(`报送事件标识重复: ${event.id}`);
  }
  const bank = roster.banks.get(event.bank_id);
  if (!bank) {
    throw new Error(`报送机构不在名册: ${event.bank_id}`);
  }
  if (!Array.isArray(event.quotes) || event.quotes.length === 0) {
    throw new Error(`报送事件 ${event.id} 没有任何期限报价`);
  }

  ledger.events.push(event);
  const versions = ledger.versionsByBank.get(event.bank_id) ?? [];
  const timeliness = classifyTimeliness(event, rules);

  const version = {
    seq: versions.length + 1,
    event_id: event.id,
    bank_id: event.bank_id,
    received_at: event.received_at,
    source: event.source,
    data_basis: event.data_basis ?? '',
    revision_reason: event.revision_reason ?? null,
    is_correction: Boolean(event.is_correction),
    timeliness,
    status: 'accepted',
    quotes: event.quotes.map((quote) => {
      const result = validateQuote(quote.value, quote.tenor, rules);
      return { tenor: quote.tenor, value: quote.value, validation: result };
    }),
  };

  let blockerCode = null;
  if (!bank.qualified) {
    version.status = 'ineligible';
    blockerCode = 'INELIGIBLE_SUBMISSION';
  } else if (timeliness === 'late') {
    // 截止后的补报或更正：只登记，绝不成为当期计算候选。
    version.status = 'late';
  } else if (!event.is_correction && !event.revision_reason && versions.some((known) => known.timeliness === 'on_time' && isDuplicateOf(known, event.quotes))) {
    version.status = 'duplicate';
    blockerCode = 'DUPLICATE_SUBMISSION';
  } else if (version.quotes.some((quote) => !quote.validation.ok)) {
    // 截止前带格式/单位问题的报送保留为无效版本，等待更正版本或剔除决定。
    version.status = 'invalid';
    blockerCode = 'FORMAT_OR_UNIT_ERROR';
  }

  versions.push(version);
  ledger.versionsByBank.set(event.bank_id, versions);
  return { received: true, event_id: event.id, status: version.status, blockerCode };
}

function onTimeCandidates(ledger, bankId) {
  return (ledger.versionsByBank.get(bankId) ?? []).filter(
    (version) => version.timeliness === 'on_time' && ['accepted', 'invalid'].includes(version.status),
  );
}

// 某机构某期限的当期有效候选：截止前、非重复、含该期限的最新版本。
// 逾期版本在此处天然不可见，因此截止后的补报不可能“悄悄进入”计算。
export function effectiveQuote(ledger, bankId, tenor) {
  const candidates = onTimeCandidates(ledger, bankId);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const quote = candidates[i].quotes.find((item) => item.tenor === tenor);
    if (quote) {
      return { version: candidates[i], quote };
    }
  }
  return null;
}

export function lateEventsOf(ledger, bankId) {
  return (ledger.versionsByBank.get(bankId) ?? []).filter((version) => version.status === 'late');
}

export function duplicatesOf(ledger, bankId) {
  return (ledger.versionsByBank.get(bankId) ?? []).filter((version) => version.status === 'duplicate');
}

// 汇总每个在册机构的分期限状态，供冻结闸门逐项核对。
export function bankStatuses(ledger, rules, roster) {
  const rows = [];
  for (const bank of roster.banks.values()) {
    const perTenor = {};
    for (const tenor of rules.tenors) {
      if (!bank.qualified) {
        perTenor[tenor.code] = { state: 'bank_ineligible' };
        continue;
      }
      const effective = effectiveQuote(ledger, bank.id, tenor.code);
      if (!effective) {
        const hasLate = lateEventsOf(ledger, bank.id).some((version) =>
          version.quotes.some((quote) => quote.tenor === tenor.code),
        );
        perTenor[tenor.code] = { state: hasLate ? 'late_only' : 'missing' };
      } else if (!effective.quote.validation.ok) {
        perTenor[tenor.code] = {
          state: 'invalid',
          event_id: effective.version.event_id,
          errors: effective.quote.validation.errors,
        };
      } else {
        perTenor[tenor.code] = {
          state: 'valid',
          event_id: effective.version.event_id,
          value: effective.quote.value,
          source: effective.version.source,
          data_basis: effective.version.data_basis,
          received_at: effective.version.received_at,
        };
      }
    }
    rows.push({ bank_id: bank.id, bank_name: bank.name, qualified: bank.qualified, perTenor });
  }
  return rows;
}

// 冻结阻断项：缺报、重复报送、单位/格式错误、无资格机构报送未处置。
// 每项都必须经双人复核决定后才能解除。
export function freezeBlockers(ledger, rules, roster) {
  const blockers = [];
  for (const row of bankStatuses(ledger, rules, roster)) {
    if (!row.qualified) {
      const submitted = (ledger.versionsByBank.get(row.bank_id) ?? []).some((version) => version.status === 'ineligible');
      if (submitted && !ledger.dispositions.get(`BANK:${row.bank_id}:INELIGIBLE`)) {
        blockers.push({
          code: 'INELIGIBLE_SUBMISSION',
          bank_id: row.bank_id,
          case_ref: `BANK:${row.bank_id}:INELIGIBLE`,
          message: `无资格机构 ${row.bank_name} 提交了报价，须双人确认剔除`,
        });
      }
      continue;
    }
    for (const tenor of rules.tenors) {
      const state = row.perTenor[tenor.code];
      if (state.state === 'valid' || state.state === 'bank_ineligible') {
        continue;
      }
      if (state.state === 'invalid') {
        const caseRef = `QUOTE:${row.bank_id}:${tenor.code}:${state.event_id}`;
        if (ledger.dispositions.has(caseRef)) {
          continue;
        }
        blockers.push({
          code: 'FORMAT_OR_UNIT_ERROR',
          bank_id: row.bank_id,
          tenor: tenor.code,
          event_id: state.event_id,
          case_ref: caseRef,
          message: `${row.bank_name} ${tenor.label}报价存在格式/单位错误：${state.errors.map((error) => error.message).join('；')}`,
        });
      } else {
        const caseRef = `TENOR:${row.bank_id}:${tenor.code}:MISSING`;
        if (ledger.dispositions.has(caseRef)) {
          continue;
        }
        blockers.push({
          code: state.state === 'late_only' ? 'MISSING_WITH_LATE_SUPPLEMENT' : 'MISSING_SUBMISSION',
          bank_id: row.bank_id,
          tenor: tenor.code,
          case_ref: caseRef,
          message:
            state.state === 'late_only'
              ? `${row.bank_name} ${tenor.label}仅有截止后补报，当期视为缺报，补报不得进入计算`
              : `${row.bank_name} ${tenor.label}缺报`,
        });
      }
    }
    for (const duplicate of duplicatesOf(ledger, row.bank_id)) {
      const caseRef = `EVENT:${duplicate.event_id}:DUPLICATE`;
      if (!ledger.dispositions.get(caseRef)) {
        blockers.push({
          code: 'DUPLICATE_SUBMISSION',
          bank_id: row.bank_id,
          event_id: duplicate.event_id,
          case_ref: caseRef,
          message: `${row.bank_name} 事件 ${duplicate.event_id} 与既有报送内容完全相同，疑似重复报送`,
        });
      }
    }
  }
  return blockers;
}
