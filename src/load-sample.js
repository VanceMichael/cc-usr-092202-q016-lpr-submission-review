import { readFile } from 'node:fs/promises';
import { createReviewSession, ReviewError } from './review.js';
import { createRuleSnapshot } from './rules.js';

// 读取报价样例，按来件时间顺序回放受理与审核动作，得到可审查的会话。
export async function loadQuoteSample(sampleUrl = new URL('../fixtures/quote-sample.json', import.meta.url)) {
  const sample = JSON.parse(await readFile(sampleUrl, 'utf8'));
  return replayQuoteSample(sample);
}

export function replayQuoteSample(sample, { rule } = {}) {
  const trace = [];
  const session = createReviewSession({
    cycle: sample.cycle,
    roster: sample.roster,
    reviewers: sample.reviewers,
    rule: rule ?? createRuleSnapshot(),
  });

  // 邮件与表格来件一律按 submittedAt 排序后走同一受理入口。
  const ordered = [...sample.intakes].sort(
    (a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt),
  );
  for (const intake of ordered) {
    const result = session.submit(intake.payload, { now: intake.submittedAt });
    trace.push({ phase: 'intake', channel: intake.channel, submissionId: intake.payload.submissionId, result });
  }

  for (const action of sample.actions ?? []) {
    if (action.type === 'comment') {
      const result = session.addReviewComment({
        institutionId: action.institutionId,
        tenor: action.tenor,
        reviewerId: action.reviewerId,
        content: action.content,
        now: action.at,
      });
      trace.push({ phase: 'comment', result });
    } else if (action.type === 'propose') {
      const result = session.proposeDecision({
        kind: action.kind,
        institutionId: action.institutionId,
        tenor: action.tenor,
        versionId: action.versionId,
        reason: action.reason,
        proposedBy: action.proposedBy,
        now: action.at,
      });
      trace.push({ phase: 'propose', result });
    } else if (action.type === 'confirm') {
      const result = session.confirmDecision(action.decisionId, {
        confirmedBy: action.confirmedBy,
        now: action.at,
      });
      trace.push({ phase: 'confirm', result });
    }
  }

  return { sample, session, trace };
}

export { ReviewError };
