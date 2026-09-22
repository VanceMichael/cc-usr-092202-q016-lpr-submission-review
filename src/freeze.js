// 冻结闸门与冻结包：
// - 缺报、重复报送、单位错误、无资格报送等阻断项未全部处置不得冻结；
// - 异常提示必须逐条有复核结论；
// - 每个期限做法定数量（最少纳入家数）检查；
// - 冻结包完整列出纳入范围、排除理由、签署记录与当时规则，供事后复核。
import { bankStatuses, effectiveQuote, freezeBlockers } from './store.js';
import { detectAnomalies } from './anomaly.js';
import { mustRecuse } from './roster.js';

// 汇总处置决定对纳入范围的影响（同一案件以最终动作为准）。
function exclusionIndex(ledger) {
  const excluded = new Map(); // case_ref -> disposition
  for (const disposition of ledger.dispositions.values()) {
    if (disposition.action === 'EXCLUDE' || disposition.action === 'CONFIRM_EXCLUDED') {
      excluded.set(disposition.case_ref, disposition);
    }
    if (disposition.action === 'RESTORE' || disposition.action === 'CONFIRM_INCLUDE') {
      excluded.delete(disposition.case_ref);
    }
  }
  return excluded;
}

// 冻结前检查，返回是否可冻结以及未决事项。
export function preFreezeCheck(ledger, rules, roster) {
  const unresolvedBlockers = freezeBlockers(ledger, rules, roster);
  const allAnomalies = detectAnomalies(ledger, rules, roster);
  const anomalies = allAnomalies.filter((item) => !ledger.dispositions.has(item.case_ref));
  const statuses = bankStatuses(ledger, rules, roster);
  const excluded = exclusionIndex(ledger);
  const perTenor = {};
  for (const tenor of rules.tenors) {
    const included = [];
    for (const row of statuses) {
      if (!row.qualified || row.perTenor[tenor.code]?.state !== 'valid') {
        continue;
      }
      const anomaly = allAnomalies.find((item) => item.bank_id === row.bank_id && item.tenor === tenor.code);
      if (!(anomaly && excluded.has(anomaly.case_ref))) {
        included.push(row.bank_id);
      }
    }
    const minRequired = rules.quorum?.min_included_per_tenor ?? 0;
    perTenor[tenor.code] = {
      included_count: included.length,
      included_banks: included,
      min_required: minRequired,
      quorum_ok: included.length >= minRequired,
    };
  }
  return {
    can_freeze:
      unresolvedBlockers.length === 0 &&
      anomalies.length === 0 &&
      Object.values(perTenor).every((item) => item.quorum_ok),
    unresolved_blockers: unresolvedBlockers,
    unresolved_anomalies: anomalies,
    quorum: perTenor,
  };
}

// 生成冻结包。调用前应先通过 preFreezeCheck；签署须两名不同审查人员。
export function freezePackage(ledger, rules, roster, signers, frozenAt = new Date().toISOString()) {
  const check = preFreezeCheck(ledger, rules, roster);
  if (!check.can_freeze) {
    const error = new Error('冻结条件不满足');
    error.check = check;
    throw error;
  }
  if (!Array.isArray(signers) || signers.length !== 2 || new Set(signers.map((s) => s.reviewer_id)).size !== 2) {
    throw new Error('冻结包须由两名不同审查人员签署');
  }
  for (const signer of signers) {
    const reviewer = roster.reviewers.get(signer.reviewer_id);
    if (!reviewer) {
      throw new Error(`签署人不在审查人员名册: ${signer.reviewer_id}`);
    }
    for (const bankId of roster.banks.keys()) {
      if (mustRecuse(roster, signer.reviewer_id, bankId)) {
        throw new Error(`签署人 ${signer.reviewer_id} 与机构 ${bankId} 存在关联，须回避，不得签署本期冻结包`);
      }
    }
  }

  const excluded = exclusionIndex(ledger);
  const anomaliesAll = detectAnomalies(ledger, rules, roster);
  const statuses = bankStatuses(ledger, rules, roster);

  const tenors = rules.tenors.map((tenor) => {
    const included = [];
    for (const row of statuses) {
      if (!row.qualified || row.perTenor[tenor.code]?.state !== 'valid') {
        continue;
      }
      const anomaly = anomaliesAll.find((item) => item.bank_id === row.bank_id && item.tenor === tenor.code);
      if (anomaly && excluded.has(anomaly.case_ref)) {
        continue;
      }
      const effective = effectiveQuote(ledger, row.bank_id, tenor.code);
      included.push({
        bank_id: row.bank_id,
        bank_name: row.bank_name,
        value: row.perTenor[tenor.code].value,
        source_event: row.perTenor[tenor.code].event_id,
        version_seq: effective.version.seq,
        source: effective.version.source,
        data_basis: effective.version.data_basis,
        received_at: effective.version.received_at,
        anomaly_case: anomaly?.case_ref ?? null,
      });
    }
    return {
      tenor: tenor.code,
      tenor_label: tenor.label,
      included_count: included.length,
      included,
    };
  });

  // 排除清单：无资格、逾期、缺报、重复、异常剔除，全部附双人决定与理由。
  const exclusions = [];
  for (const row of statuses) {
    if (!row.qualified) {
      const disposition = ledger.dispositions.get(`BANK:${row.bank_id}:INELIGIBLE`);
      if (disposition) {
        exclusions.push({
          bank_id: row.bank_id,
          bank_name: row.bank_name,
          scope: 'BANK',
          reason_code: 'INELIGIBLE_SUBMISSION',
          reason: roster.banks.get(row.bank_id).disqualified_reason ?? '机构无报价资格',
          case_ref: disposition.case_ref,
          decision: disposition,
        });
      }
      continue;
    }
    for (const tenor of rules.tenors) {
      const state = row.perTenor[tenor.code];
      if (state.state === 'late_only') {
        const disposition = ledger.dispositions.get(`TENOR:${row.bank_id}:${tenor.code}:MISSING`);
        exclusions.push({
          bank_id: row.bank_id,
          bank_name: row.bank_name,
          tenor: tenor.code,
          scope: 'TENOR',
          reason_code: 'LATE_SUPPLEMENT_EXCLUDED',
          reason: `${tenor.label}仅有截止后补报，按规则不得进入当期计算`,
          case_ref: disposition?.case_ref ?? null,
          decision: disposition ?? null,
        });
      } else if (state.state === 'missing') {
        const disposition = ledger.dispositions.get(`TENOR:${row.bank_id}:${tenor.code}:MISSING`);
        exclusions.push({
          bank_id: row.bank_id,
          bank_name: row.bank_name,
          tenor: tenor.code,
          scope: 'TENOR',
          reason_code: 'MISSING_SUBMISSION',
          reason: `${tenor.label}缺报`,
          case_ref: disposition?.case_ref ?? null,
          decision: disposition ?? null,
        });
      }
    }
    for (const version of ledger.versionsByBank.get(row.bank_id) ?? []) {
      if (version.status === 'late') {
        exclusions.push({
          bank_id: row.bank_id,
          bank_name: row.bank_name,
          scope: 'EVENT',
          reason_code: 'AFTER_DEADLINE',
          reason: `事件 ${version.event_id} 在截止后接收（${version.received_at}），仅登记留痕，不进入当期计算`,
          event_id: version.event_id,
          case_ref: null,
          decision: null,
        });
      }
    }
    for (const anomaly of anomaliesAll.filter((item) => item.bank_id === row.bank_id)) {
      const disposition = excluded.get(anomaly.case_ref);
      if (disposition) {
        exclusions.push({
          bank_id: row.bank_id,
          bank_name: row.bank_name,
          tenor: anomaly.tenor,
          scope: 'TENOR',
          reason_code: 'ANOMALY_EXCLUDED',
          reason: `异常报价经双人复核剔除：${anomaly.reasons.map((r) => r.detail).join('；')}`,
          case_ref: anomaly.case_ref,
          decision: disposition,
        });
      }
    }
  }
  for (const disposition of ledger.dispositions.values()) {
    if (disposition.action === 'IGNORE_DUPLICATE' && disposition.case_ref.startsWith('EVENT:')) {
      const bankId = disposition.bank_id;
      exclusions.push({
        bank_id: bankId,
        bank_name: roster.banks.get(bankId).name,
        scope: 'EVENT',
        reason_code: 'DUPLICATE_SUBMISSION',
        reason: '与既有报送内容完全相同，按重复报送登记，以首次有效报送为准',
        case_ref: disposition.case_ref,
        decision: disposition,
      });
    }
  }

  const signingRecords = [
    ...[...ledger.reviews.values()]
      .filter((item) => item.status === 'finalized')
      .map((item) => ({ kind: 'REVIEW_DECISION', ...ledger.dispositions.get(item.case_ref) })),
    {
      kind: 'FREEZE_SIGNATURE',
      signed_at: frozenAt,
      rules_version: rules.rules_version,
      signers: signers.map((signer) => ({
        reviewer_id: signer.reviewer_id,
        reviewer_name: roster.reviewers.get(signer.reviewer_id).name,
        comment: signer.comment ?? '',
      })),
    },
  ];

  return {
    package_id: `FREEZE-${rules.period_id}-${frozenAt.replace(/[-:T.Z+]/g, '').slice(0, 14)}`,
    period_id: rules.period_id,
    frozen_at: frozenAt,
    rules_version: rules.rules_version,
    rules_snapshot: rules,
    tenors,
    exclusions,
    signing_records: signingRecords,
  };
}
