import { createHash } from 'node:crypto';
import {
  createRuleSnapshot,
  validateQuoteFormat,
  median,
  TENOR_1Y,
  TENOR_5Y,
} from './rules.js';

// 报送材料在审查会话中的状态。
const VERSION = {
  VALID: 'valid', // 当期有效候选
  INVALID: 'invalid', // 格式校验未通过（如单位错误），阻断冻结
  SUPERSEDED: 'superseded', // 被截止前更正替代
  INVALID_SUPERSEDED: 'invalid-superseded',
  EXCLUDED: 'excluded', // 双人确认后剔除，不纳入计算
  DUPLICATE: 'duplicate', // 重复报送，待认定
  VOIDED: 'voided', // 双人确认后认定作废
};

export class ReviewError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

function toTime(value) {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return Date.parse(value);
  return Number.NaN;
}

function stableClone(value) {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

// 递归按键排序后序列化，保证冻结摘要可复算。
function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function createReviewSession({ cycle, roster, reviewers, rule }) {
  if (!cycle || !cycle.cycleId || !cycle.windowOpenAt || !cycle.deadlineAt) {
    throw new ReviewError('CYCLE_INVALID', '报价周期缺少窗口设置');
  }
  const ruleSnapshot = rule ?? createRuleSnapshot();
  const state = {
    cycle: { ...cycle, windowOpenAt: toTime(cycle.windowOpenAt), deadlineAt: toTime(cycle.deadlineAt) },
    ruleSnapshot,
    roster: roster.map((entry) => ({ ...entry })),
    reviewers: reviewers.map((entry) => ({
      ...entry,
      affiliatedInstitutionIds: entry.affiliatedInstitutionIds ?? [],
    })),
    // 键为 机构|期限。
    slots: new Map(),
    // 无资格机构来件、无法归属期限的来件，只登记备查。
    strayIntakes: [],
    malformedIntakes: [],
    // 全部处置（提出/确认/撤回）留痕。
    decisions: [],
    status: 'open',
    frozenPackage: null,
    counters: { decision: 0 },
  };

  const slotKey = (institutionId, tenor) => `${institutionId}|${tenor}`;
  const rosterEntry = (institutionId) =>
    state.roster.find((entry) => entry.institutionId === institutionId);
  const reviewerEntry = (reviewerId) =>
    state.reviewers.find((entry) => entry.id === reviewerId);
  const isTenor = (tenor) => state.ruleSnapshot.tenors.some((t) => t.code === tenor);

  function assertOpen() {
    if (state.status === 'frozen') {
      throw new ReviewError('CYCLE_FROZEN', '本期报价已冻结，不再受理变更');
    }
  }

  function getSlot(institutionId, tenor) {
    return state.slots.get(slotKey(institutionId, tenor)) ?? null;
  }

  function ensureSlot(institution, tenor) {
    const key = slotKey(institution.institutionId, tenor);
    let slot = state.slots.get(key);
    if (!slot) {
      slot = {
        institutionId: institution.institutionId,
        institutionName: institution.name,
        tenor,
        versions: [],
        lateIntakes: [],
        comments: [],
        currentVersionId: null,
      };
      state.slots.set(key, slot);
    }
    return slot;
  }

  function currentVersion(slot) {
    if (!slot || !slot.currentVersionId) return null;
    return slot.versions.find((version) => version.versionId === slot.currentVersionId) ?? null;
  }

  // 与该机构有利害关系的审核员必须回避。
  function eligibleReviewers(institutionId) {
    return state.reviewers.filter(
      (reviewer) =>
        reviewer.status !== 'inactive' &&
        !reviewer.affiliatedInstitutionIds.includes(institutionId),
    );
  }

  function assertNoConflict(reviewerId, institutionId) {
    const reviewer = reviewerEntry(reviewerId);
    if (!reviewer) throw new ReviewError('REVIEWER_UNKNOWN', '审核员不存在');
    if (reviewer.status === 'inactive') {
      throw new ReviewError('REVIEWER_INACTIVE', '审核员已停用');
    }
    if (reviewer.affiliatedInstitutionIds.includes(institutionId)) {
      throw new ReviewError(
        'CONFLICT_RECUSAL',
        `审核员 ${reviewerId} 与机构 ${institutionId} 有利害关系，必须回避`,
        { reviewerId, institutionId },
      );
    }
  }

  // 受理一条报送（邮件或表格来件统一走这里）。
  function submit(payload, options = {}) {
    assertOpen();
    const at = toTime(options.now ?? payload.submittedAt ?? Date.now());
    if (!Number.isFinite(at)) {
      throw new ReviewError('TIMESTAMP_INVALID', '报送时间无法识别');
    }

    const institution = rosterEntry(payload.institutionId);
    if (!institution || institution.status !== 'active') {
      // 无资格机构来件隔离登记，绝不进入任何机构可见材料或计算。
      state.strayIntakes.push({
        intake: stableClone(payload),
        submittedAt: at,
        reason: 'INSTITUTION_NOT_ELIGIBLE',
      });
      return { accepted: false, registered: 'stray', reason: 'INSTITUTION_NOT_ELIGIBLE' };
    }

    if (!isTenor(payload.tenor)) {
      state.malformedIntakes.push({
        intake: stableClone(payload),
        submittedAt: at,
        reason: 'TENOR_UNKNOWN',
      });
      return {
        accepted: false,
        registered: 'malformed',
        reason: 'TENOR_UNKNOWN',
        formatErrors: ['TENOR_MISSING', 'TENOR_UNKNOWN'],
      };
    }

    if (at < state.cycle.windowOpenAt) {
      return { accepted: false, reason: 'WINDOW_NOT_OPEN' };
    }

    const formatErrors = validateQuoteFormat(payload, state.ruleSnapshot);
    const slot = ensureSlot(institution, payload.tenor);

    // 截止后：无论缺报补报还是更正，一律只登记备查，不进入当期计算，
    // 也不能因此把缺报补齐。
    if (at > state.cycle.deadlineAt) {
      slot.lateIntakes.push({
        intakeId: payload.submissionId ?? null,
        value: payload.value,
        unit: payload.unit,
        sourceDescription: payload.sourceDescription,
        revisionReason: payload.revisionReason ?? null,
        submittedAt: at,
        formatErrors: stableClone(formatErrors),
        status: 'late-registered',
      });
      return {
        accepted: false,
        registered: 'late',
        reason: 'AFTER_DEADLINE_REGISTER_ONLY',
        formatErrors: stableClone(formatErrors),
      };
    }

    const previous = currentVersion(slot);
    const sameContent =
      previous &&
      previous.status === VERSION.VALID &&
      previous.value === payload.value &&
      previous.unit === payload.unit;

    // 截止前再次报送：内容相同按重复报送挂起；内容不同按更正确认修订理由。
    if (previous && !sameContent) {
      if (typeof payload.revisionReason !== 'string' || payload.revisionReason.trim() === '') {
        return { accepted: false, reason: 'REVISION_REASON_REQUIRED' };
      }
    }

    const seq = slot.versions.length + 1;
    const version = {
      versionId: `${slot.institutionId}-${slot.tenor}-v${seq}`,
      submissionId: payload.submissionId ?? null,
      seq,
      value: payload.value,
      unit: payload.unit,
      sourceDescription: payload.sourceDescription?.trim() ?? '',
      revisionReason: previous && !sameContent ? payload.revisionReason.trim() : null,
      submittedAt: at,
      formatErrors: stableClone(formatErrors),
      status: formatErrors.length ? VERSION.INVALID : VERSION.VALID,
      decisionIds: [],
    };

    if (sameContent) {
      // 重复报送不改变当前版本，单独挂起，阻断冻结，等待双人认定。
      version.status = VERSION.DUPLICATE;
      version.revisionReason = null;
    } else if (previous) {
      if (previous.status === VERSION.VALID) previous.status = VERSION.SUPERSEDED;
      else if (previous.status === VERSION.INVALID) previous.status = VERSION.INVALID_SUPERSEDED;
      // 已剔除版本保持 excluded：剔除决定针对该版本本身。
      slot.currentVersionId = version.versionId;
    } else {
      slot.currentVersionId = version.versionId;
    }

    slot.versions.push(version);
    return {
      accepted: true,
      versionId: version.versionId,
      status: version.status,
      formatErrors: stableClone(formatErrors),
    };
  }

  // 同期限当前报价相对中位数的偏离提示（仅提示，不自动剔除）。
  // includeNonValid 用于冻结包：被剔除版本同样留痕，并标注其处置状态，
  // 使“异常提示→剔除”的过程可以复核；计算基准始终只取有效报价。
  function reviewAnomalies({ includeNonValid = false } = {}) {
    const flags = [];
    for (const tenor of state.ruleSnapshot.tenors.map((t) => t.code)) {
      const validPairs = [...state.slots.values()]
        .filter((slot) => slot.tenor === tenor)
        .map((slot) => ({ slot, version: currentVersion(slot) }))
        .filter((pair) => pair.version && pair.version.status === VERSION.VALID);
      if (validPairs.length < 3) continue;
      const basis = median(validPairs.map((pair) => pair.version.value));
      const pairs = includeNonValid
        ? [...state.slots.values()]
            .filter((slot) => slot.tenor === tenor)
            .map((slot) => ({ slot, version: currentVersion(slot) }))
            .filter((pair) => pair.version !== null)
        : validPairs;
      for (const { slot, version } of pairs) {
        const ratio = Math.abs(version.value - basis) / basis;
        let level = null;
        if (ratio >= state.ruleSnapshot.anomaly.severeRatio) level = 'severe';
        else if (ratio >= state.ruleSnapshot.anomaly.warnRatio) level = 'warn';
        if (level) {
          flags.push({
            institutionId: slot.institutionId,
            tenor,
            versionId: version.versionId,
            value: version.value,
            medianBasis: basis,
            deviationRatio: Number(ratio.toFixed(6)),
            level,
            status: version.status,
          });
        }
      }
    }
    return flags.sort((a, b) => b.deviationRatio - a.deviationRatio);
  }

  function proposeDecision({ kind, institutionId, tenor, versionId = null, reason, proposedBy, now }) {
    assertOpen();
    if (!['EXCLUDE', 'RESTORE', 'VOID_DUPLICATE'].includes(kind)) {
      throw new ReviewError('DECISION_KIND_UNKNOWN', '不支持的处置类型');
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new ReviewError('REASON_REQUIRED', '处置必须填写理由');
    }
    assertNoConflict(proposedBy, institutionId);
    const slot = getSlot(institutionId, tenor);
    if (!slot) throw new ReviewError('SLOT_NOT_FOUND', '该机构该期限尚无报送材料');

    let target = currentVersion(slot);
    if (versionId) target = slot.versions.find((version) => version.versionId === versionId) ?? null;
    if (!target) throw new ReviewError('VERSION_NOT_FOUND', '目标版本不存在');

    if (kind === 'EXCLUDE' && target.status !== VERSION.VALID) {
      throw new ReviewError('TARGET_NOT_VALID', '只能对当期有效版本提出剔除');
    }
    if (kind === 'RESTORE') {
      if (target.status !== VERSION.EXCLUDED) {
        throw new ReviewError('TARGET_NOT_EXCLUDED', '只能恢复已剔除版本');
      }
      if (slot.currentVersionId !== target.versionId) {
        throw new ReviewError('TARGET_NOT_CURRENT', '被更正替代的旧版本不能恢复为当期有效');
      }
    }
    if (kind === 'VOID_DUPLICATE' && target.status !== VERSION.DUPLICATE) {
      throw new ReviewError('TARGET_NOT_DUPLICATE', '只能认定重复报送版本');
    }

    state.counters.decision += 1;
    const decision = {
      decisionId: `dec-${String(state.counters.decision).padStart(3, '0')}`,
      kind,
      target: { institutionId, tenor, versionId: target.versionId },
      reason: reason.trim(),
      proposedBy,
      confirmedBy: null,
      proposedAt: toTime(now ?? Date.now()),
      confirmedAt: null,
      status: 'pending',
      ruleSetId: state.ruleSnapshot.ruleSetId,
      ruleVersion: state.ruleSnapshot.version,
    };
    state.decisions.push(decision);
    return stableClone(decision);
  }

  // 第二名审核员确认；必须与提出人不同且同样无利害关系。
  function confirmDecision(decisionId, { confirmedBy, now } = {}) {
    assertOpen();
    const decision = state.decisions.find((item) => item.decisionId === decisionId);
    if (!decision) throw new ReviewError('DECISION_NOT_FOUND', '处置记录不存在');
    if (decision.status !== 'pending') {
      throw new ReviewError('DECISION_NOT_PENDING', '该处置已结束，不能再次确认');
    }
    if (decision.proposedBy === confirmedBy) {
      throw new ReviewError('SAME_CONFIRMER', '提出人与确认人不得为同一人');
    }
    assertNoConflict(confirmedBy, decision.target.institutionId);

    const slot = getSlot(decision.target.institutionId, decision.target.tenor);
    const target = slot.versions.find((v) => v.versionId === decision.target.versionId);

    if (decision.kind === 'EXCLUDE') target.status = VERSION.EXCLUDED;
    if (decision.kind === 'RESTORE') target.status = VERSION.VALID;
    if (decision.kind === 'VOID_DUPLICATE') target.status = VERSION.VOIDED;
    target.decisionIds.push(decision.decisionId);

    decision.confirmedBy = confirmedBy;
    decision.confirmedAt = toTime(now ?? Date.now());
    decision.status = 'applied';
    return stableClone(decision);
  }

  function withdrawDecision(decisionId, { actorId, now } = {}) {
    assertOpen();
    const decision = state.decisions.find((item) => item.decisionId === decisionId);
    if (!decision) throw new ReviewError('DECISION_NOT_FOUND', '处置记录不存在');
    if (decision.status !== 'pending') {
      throw new ReviewError('DECISION_NOT_PENDING', '该处置已结束，不能撤回');
    }
    if (decision.proposedBy !== actorId) {
      throw new ReviewError('NOT_PROPOSER', '仅提出人可撤回本人意见');
    }
    decision.status = 'withdrawn';
    decision.withdrawnAt = toTime(now ?? Date.now());
    return stableClone(decision);
  }

  // 系统回避分派：按待处理工作量从无利害关系审核员中挑两人，
  // 提出人与确认人天然不同；利害关系审核员不在候选内。
  function suggestReviewerPair(institutionId) {
    const pendingLoad = new Map(state.reviewers.map((reviewer) => [reviewer.id, 0]));
    for (const decision of state.decisions) {
      if (decision.status !== 'pending') continue;
      pendingLoad.set(decision.proposedBy, (pendingLoad.get(decision.proposedBy) ?? 0) + 1);
      if (decision.confirmedBy) {
        pendingLoad.set(decision.confirmedBy, (pendingLoad.get(decision.confirmedBy) ?? 0) + 1);
      }
    }
    return eligibleReviewers(institutionId)
      .map((reviewer) => ({
        id: reviewer.id,
        name: reviewer.name,
        pendingLoad: pendingLoad.get(reviewer.id) ?? 0,
      }))
      .sort((a, b) =>
        a.pendingLoad === b.pendingLoad ? a.id.localeCompare(b.id) : a.pendingLoad - b.pendingLoad,
      )
      .slice(0, 2);
  }

  // 审核意见不改变数据，同样要求回避，机构可在自身材料中看到。
  function addReviewComment({ institutionId, tenor, reviewerId, content, now }) {
    assertOpen();
    if (typeof content !== 'string' || content.trim() === '') {
      throw new ReviewError('COMMENT_REQUIRED', '审核意见不能为空');
    }
    assertNoConflict(reviewerId, institutionId);
    const slot = getSlot(institutionId, tenor);
    if (!slot) throw new ReviewError('SLOT_NOT_FOUND', '该机构该期限尚无报送材料');
    const comment = {
      commentId: `cmt-${slot.comments.length + 1}`,
      reviewerId,
      content: content.trim(),
      createdAt: toTime(now ?? Date.now()),
    };
    slot.comments.push(comment);
    return stableClone(comment);
  }

  function eachRosterSlot() {
    const result = [];
    for (const institution of state.roster) {
      if (institution.status !== 'active') continue;
      for (const { code: tenor } of state.ruleSnapshot.tenors) {
        result.push({ institution, tenor, slot: getSlot(institution.institutionId, tenor) });
      }
    }
    return result;
  }

  // 冻结阻断项：缺报、单位/格式错误、重复报送、未完成双人确认、法定数量不足。
  function freezeBlockers() {
    const blockers = [];

    for (const decision of state.decisions) {
      if (decision.status === 'pending') {
        blockers.push({
          code: 'PENDING_DUAL_CONFIRMATION',
          decisionId: decision.decisionId,
          institutionId: decision.target.institutionId,
          tenor: decision.target.tenor,
        });
      }
    }

    for (const { institution, tenor, slot } of eachRosterSlot()) {
      const current = currentVersion(slot);
      if (!current) {
        blockers.push({ code: 'MISSING_REPORT', institutionId: institution.institutionId, tenor });
        continue;
      }
      if (current.status === VERSION.INVALID) {
        blockers.push({
          code: 'FORMAT_INVALID',
          institutionId: institution.institutionId,
          tenor,
          versionId: current.versionId,
          errors: current.formatErrors,
        });
      }
      const duplicate = slot.versions.find((version) => version.status === VERSION.DUPLICATE);
      if (duplicate) {
        blockers.push({
          code: 'DUPLICATE_UNRESOLVED',
          institutionId: institution.institutionId,
          tenor,
          versionId: duplicate.versionId,
        });
      }
    }

    for (const { code: tenor } of state.ruleSnapshot.tenors) {
      const included = [...state.slots.values()]
        .filter((slot) => slot.tenor === tenor)
        .map(currentVersion)
        .filter((version) => version && version.status === VERSION.VALID).length;
      if (included < state.ruleSnapshot.quorum.minIncludedPerTenor) {
        blockers.push({
          code: 'QUORUM_NOT_MET',
          tenor,
          included,
          required: state.ruleSnapshot.quorum.minIncludedPerTenor,
        });
      }
    }

    return blockers.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }

  function reviewerName(id) {
    return reviewerEntry(id)?.name ?? id;
  }

  function decisionSummary(decisionId) {
    const decision = state.decisions.find((item) => item.decisionId === decisionId);
    if (!decision) return null;
    return {
      decisionId: decision.decisionId,
      kind: decision.kind,
      reason: decision.reason,
      status: decision.status,
      proposedBy: { id: decision.proposedBy, name: reviewerName(decision.proposedBy) },
      confirmedBy: decision.confirmedBy
        ? { id: decision.confirmedBy, name: reviewerName(decision.confirmedBy) }
        : null,
      rule: { ruleSetId: decision.ruleSetId, version: decision.ruleVersion },
    };
  }

  function buildPackage(operatorId, frozenAt) {
    const included = [];
    const slotsAudit = [];

    for (const { institution, tenor, slot } of eachRosterSlot()) {
      if (!slot) continue;
      const current = currentVersion(slot);
      if (current && current.status === VERSION.VALID) {
        included.push({
          institution: { id: institution.institutionId, name: institution.name },
          tenor,
          value: current.value,
          unit: current.unit,
          versionId: current.versionId,
          submittedAt: current.submittedAt,
          sourceDescription: current.sourceDescription,
        });
      }
      slotsAudit.push({
        institution: { id: institution.institutionId, name: institution.name },
        tenor: slot.tenor,
        currentVersionId: slot.currentVersionId,
        versions: slot.versions.map((version) => ({
          versionId: version.versionId,
          seq: version.seq,
          status: version.status,
          value: version.value,
          unit: version.unit,
          submittedAt: version.submittedAt,
          sourceDescription: version.sourceDescription,
          revisionReason: version.revisionReason,
          formatErrors: version.formatErrors,
          decisions: version.decisionIds.map(decisionSummary),
        })),
        lateIntakes: stableClone(slot.lateIntakes),
        comments: stableClone(slot.comments),
      });
    }

    const excluded = [];
    for (const audit of slotsAudit) {
      for (const version of audit.versions) {
        if (version.status === VERSION.EXCLUDED) {
          const applied = version.decisions.find((d) => d.kind === 'EXCLUDE' && d.status === 'applied');
          excluded.push({
            institution: audit.institution,
            tenor: audit.tenor,
            versionId: version.versionId,
            value: version.value,
            reasonCode: 'REVIEW_EXCLUDED',
            reason: applied?.reason ?? null,
            decision: applied,
          });
        }
        if (version.status === VERSION.SUPERSEDED) {
          excluded.push({
            institution: audit.institution,
            tenor: audit.tenor,
            versionId: version.versionId,
            value: version.value,
            reasonCode: 'SUPERSEDED_BY_REVISION',
            reason: '截止前被更正后的新版本替代，旧版本留痕',
            revisionReason: audit.versions.find((v) => v.seq === version.seq + 1)?.revisionReason ?? null,
          });
        }
        if (version.status === VERSION.INVALID_SUPERSEDED) {
          excluded.push({
            institution: audit.institution,
            tenor: audit.tenor,
            versionId: version.versionId,
            value: version.value,
            reasonCode: 'FORMAT_ERROR_SUPERSEDED',
            reason: '格式校验未通过且已被截止前更正版本替代',
            formatErrors: version.formatErrors,
          });
        }
        if (version.status === VERSION.VOIDED) {
          const applied = version.decisions.find((d) => d.kind === 'VOID_DUPLICATE' && d.status === 'applied');
          excluded.push({
            institution: audit.institution,
            tenor: audit.tenor,
            versionId: version.versionId,
            value: version.value,
            reasonCode: 'DUPLICATE_VOIDED',
            reason: applied?.reason ?? null,
            decision: applied,
          });
        }
      }
      for (const late of audit.lateIntakes) {
        excluded.push({
          institution: audit.institution,
          tenor: audit.tenor,
          versionId: null,
          value: late.value,
          submittedAt: late.submittedAt,
          reasonCode: 'AFTER_DEADLINE_REGISTER_ONLY',
          reason: '截止后来件，仅登记备查，不进入当期计算',
          formatErrors: late.formatErrors,
        });
      }
    }

    const quorum = state.ruleSnapshot.tenors.map(({ code, label }) => {
      const count = included.filter((item) => item.tenor === code).length;
      return {
        tenor: code,
        label,
        rosterCount: state.roster.filter((entry) => entry.status === 'active').length,
        includedCount: count,
        required: state.ruleSnapshot.quorum.minIncludedPerTenor,
        met: count >= state.ruleSnapshot.quorum.minIncludedPerTenor,
      };
    });

    const signRecords = state.decisions
      .filter((decision) => decision.status === 'applied')
      .map((decision) => ({
        decisionId: decision.decisionId,
        action: decision.kind,
        target: decision.target,
        reason: decision.reason,
        proposedBy: { id: decision.proposedBy, name: reviewerName(decision.proposedBy) },
        confirmedBy: { id: decision.confirmedBy, name: reviewerName(decision.confirmedBy) },
        proposedAt: decision.proposedAt,
        confirmedAt: decision.confirmedAt,
        ruleInEffect: { ruleSetId: decision.ruleSetId, version: decision.ruleVersion },
      }));

    const pkg = {
      packageId: `${state.cycle.cycleId}-frozen`,
      cycle: state.cycle,
      frozenAt,
      operator: { id: operatorId, name: reviewerEntry(operatorId)?.name ?? operatorId },
      ruleSnapshot: state.ruleSnapshot,
      quorum,
      included: included.sort((a, b) =>
        a.tenor === b.tenor
          ? a.institution.id.localeCompare(b.institution.id)
          : a.tenor.localeCompare(b.tenor),
      ),
      excluded,
      notEligibleIntakes: stableClone(state.strayIntakes),
      malformedIntakes: stableClone(state.malformedIntakes),
      anomalyFlags: reviewAnomalies({ includeNonValid: true }),
      auditTrail: slotsAudit,
      signRecords,
      decisionLedger: stableClone(state.decisions),
    };
    pkg.digest = createHash('sha256').update(canonicalStringify(pkg)).digest('hex');
    return pkg;
  }

  function freeze({ operatorId, now } = {}) {
    assertOpen();
    if (!operatorId) throw new ReviewError('OPERATOR_REQUIRED', '冻结必须记录操作人');
    const blockers = freezeBlockers();
    if (blockers.length) return { frozen: false, blockers };
    const frozenAt = toTime(now ?? Date.now());
    state.frozenPackage = buildPackage(operatorId, frozenAt);
    state.status = 'frozen';
    return { frozen: true, package: state.frozenPackage };
  }

  // 机构视角：只能看到本机构材料，看不到其他机构数据，也取不到冻结包。
  function institutionView(institutionId) {
    const institution = rosterEntry(institutionId);
    if (!institution || institution.status !== 'active') {
      return { allowed: false };
    }
    const ownSlots = state.ruleSnapshot.tenors.map(({ code }) => getSlot(institutionId, code)).filter(Boolean);
    return {
      allowed: true,
      cycle: {
        cycleId: state.cycle.cycleId,
        publishDate: state.cycle.publishDate ?? null,
        windowOpenAt: state.cycle.windowOpenAt,
        deadlineAt: state.cycle.deadlineAt,
        frozen: state.status === 'frozen',
      },
      submissions: ownSlots.map((slot) => ({
        tenor: slot.tenor,
        currentVersionId: slot.currentVersionId,
        versions: slot.versions.map((version) => ({
          versionId: version.versionId,
          seq: version.seq,
          status: version.status,
          value: version.value,
          unit: version.unit,
          submittedAt: version.submittedAt,
          sourceDescription: version.sourceDescription,
          revisionReason: version.revisionReason,
          formatErrors: version.formatErrors,
          reviewComments: stableClone(slot.comments),
          decisions: version.decisionIds.map(decisionSummary),
        })),
        lateIntakes: stableClone(slot.lateIntakes),
      })),
    };
  }

  return {
    submit,
    reviewAnomalies,
    eligibleReviewers,
    suggestReviewerPair,
    proposeDecision,
    confirmDecision,
    withdrawDecision,
    addReviewComment,
    freezeBlockers,
    freeze,
    institutionView,
    // 供后台界面与测试读取的内部视角（中心审核/审计人员）。
    get status() {
      return state.status;
    },
    get frozenPackage() {
      return state.frozenPackage;
    },
    get slots() {
      return [...state.slots.values()];
    },
    get strayIntakes() {
      return stableClone(state.strayIntakes);
    },
    get malformedIntakes() {
      return stableClone(state.malformedIntakes);
    },
    get decisions() {
      return stableClone(state.decisions);
    },
    get ruleSnapshot() {
      return stableClone(state.ruleSnapshot);
    },
  };
}

export { TENOR_1Y, TENOR_5Y };
