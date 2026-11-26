/**
 * Blast radius: what a grant would actually touch.
 *
 * The point of the product is that delegation without context is a bet. This
 * module turns the raw context we can read — Jira issue state, links, pull
 * requests and goals from Teamwork Graph, the last thing anyone said in the
 * thread — into a small set of *named* signals plus a risk read.
 *
 * Two rules keep it honest:
 *   - every signal cites the issue keys that produced it, so the human can
 *     check the claim instead of trusting a score;
 *   - signals that argue *for* closing are kept separate from signals that
 *     argue against, because a list that only points one way is a pitch, not a
 *     briefing.
 *
 * Pure: no I/O. The caller assembles `issues` from Jira + TWG.
 */

export const RISK = Object.freeze({ LOW: 'low', MEDIUM: 'medium', HIGH: 'high' });

export const SIGNAL = Object.freeze({
  UNMERGED_PR: 'unmerged_pr',
  ACTIVE_DISCUSSION: 'active_discussion',
  BLOCKS_OTHERS: 'blocks_others',
  BLOCKED_BY: 'blocked_by',
  GOAL_AT_RISK: 'goal_at_risk',
  CUSTOMER_FACING: 'customer_facing',
  QUIET: 'quiet',
});

const ACTIVE_HOURS = 48;
const QUIET_DAYS = 30;

const DEFINITIONS = {
  [SIGNAL.UNMERGED_PR]: {
    weight: 3,
    label: 'Code is mid-flight',
    detail: 'a pull request linked to this issue has not been merged',
  },
  [SIGNAL.ACTIVE_DISCUSSION]: {
    weight: 3,
    label: 'Someone is talking about this now',
    detail: `there is a comment from the last ${ACTIVE_HOURS} hours`,
  },
  [SIGNAL.BLOCKS_OTHERS]: {
    weight: 3,
    label: 'Other work is waiting on this',
    detail: 'this issue blocks work that is still open',
  },
  [SIGNAL.BLOCKED_BY]: {
    weight: 2,
    label: 'This is waiting on something else',
    detail: 'an issue it depends on is still open',
  },
  [SIGNAL.GOAL_AT_RISK]: {
    weight: 2,
    label: 'A goal is attached',
    detail: 'closing this issue moves a goal the team is tracking',
  },
  [SIGNAL.CUSTOMER_FACING]: {
    weight: 2,
    label: 'A customer reported it',
    detail: 'the issue carries a customer, support or severity marker',
  },
  [SIGNAL.QUIET]: {
    weight: -2,
    label: 'Nothing has happened in a month',
    detail: 'no update and no comment for 30 days',
  },
};

const CUSTOMER_MARKERS = ['customer', 'cs-', 'support', 'severity', 'escalation', 'vip'];

/**
 * @param {object} input
 * @param {Array} input.issues  normalised issues (see normaliseIssue)
 * @param {number} input.now
 */
export function buildBlastRadius({ issues = [], now = Date.now() }) {
  const items = issues.map((i) => normaliseIssue(i));
  const hit = new Map(Object.keys(DEFINITIONS).map((code) => [code, []]));

  for (const issue of items) {
    if (issue.unmergedPrs.length > 0) hit.get(SIGNAL.UNMERGED_PR).push(issue.key);
    if (issue.lastCommentAt !== null && hoursSince(issue.lastCommentAt, now) <= ACTIVE_HOURS) {
      hit.get(SIGNAL.ACTIVE_DISCUSSION).push(issue.key);
    }
    if (issue.blocks.length > 0) hit.get(SIGNAL.BLOCKS_OTHERS).push(issue.key);
    if (issue.blockedBy.length > 0) hit.get(SIGNAL.BLOCKED_BY).push(issue.key);
    if (issue.goals.length > 0) hit.get(SIGNAL.GOAL_AT_RISK).push(issue.key);
    if (isCustomerFacing(issue)) hit.get(SIGNAL.CUSTOMER_FACING).push(issue.key);
    if (isQuiet(issue, now)) hit.get(SIGNAL.QUIET).push(issue.key);
  }

  const present = [];
  for (const [code, keys] of hit) {
    if (keys.length === 0) continue;
    const def = DEFINITIONS[code];
    present.push({
      code,
      label: def.label,
      detail: def.detail,
      weight: def.weight,
      count: keys.length,
      issueKeys: keys.slice(0, 20),
    });
  }
  present.sort(
    (a, b) => Math.abs(b.weight) - Math.abs(a.weight) || b.count - a.count || a.code.localeCompare(b.code),
  );

  const against = present.filter((s) => s.weight > 0);
  const forIt = present.filter((s) => s.weight < 0);
  // Risk reads only the signals that argue against delegating. Reasons to go
  // ahead are shown next to them but never cancel them out — a quiet issue does
  // not make a pull request mid-flight safe.
  const score = against.reduce((sum, s) => sum + s.weight, 0);
  return {
    computedAt: new Date(now).toISOString(),
    issueCount: items.length,
    against,
    forIt,
    score,
    risk: score >= 6 ? RISK.HIGH : score >= 3 ? RISK.MEDIUM : RISK.LOW,
    headline: headlineFor(against, forIt, items.length),
    projects: countBy(items.map((i) => String(i.key).split('-')[0])),
  };
}

/** One sentence a human can read in a review without opening anything. */
export function headlineFor(against, forIt, issueCount) {
  if (issueCount === 0) return 'Nothing to look at yet.';
  if (against.length === 0) {
    const quiet = forIt.find((s) => s.code === SIGNAL.QUIET);
    if (quiet && quiet.count === issueCount) {
      return `All ${issueCount} issues have been untouched for a month.`;
    }
    return `No pull requests, dependencies or recent activity turned up for these ${issueCount} issues.`;
  }
  const parts = against.slice(0, 2).map((s) => `${s.count} ${describeSignal(s)}`);
  const rest = against.length - parts.length;
  const tail = rest > 0 ? ` and ${rest} more signal${rest === 1 ? '' : 's'}` : '';
  return capitalise(parts.join(', ')) + tail + '.';
}

function describeSignal(signal) {
  switch (signal.code) {
    case SIGNAL.UNMERGED_PR:
      return signal.count === 1 ? 'issue has code mid-flight' : 'issues have code mid-flight';
    case SIGNAL.ACTIVE_DISCUSSION:
      return signal.count === 1 ? 'issue is being discussed right now' : 'issues are being discussed right now';
    case SIGNAL.BLOCKS_OTHERS:
      return signal.count === 1 ? 'issue is blocking other work' : 'issues are blocking other work';
    case SIGNAL.BLOCKED_BY:
      return signal.count === 1 ? 'issue is itself blocked' : 'issues are themselves blocked';
    case SIGNAL.GOAL_AT_RISK:
      return signal.count === 1 ? 'issue carries a goal' : 'issues carry goals';
    case SIGNAL.CUSTOMER_FACING:
      return signal.count === 1 ? 'issue came from a customer' : 'issues came from customers';
    default:
      return `${signal.label.toLowerCase()}`;
  }
}

export function normaliseIssue(issue = {}) {
  const updated = dateOrNull(issue.updatedAt);
  const lastComment = dateOrNull(issue.lastCommentAt);
  return {
    key: String(issue.key || '').toUpperCase(),
    summary: String(issue.summary || ''),
    status: String(issue.status || ''),
    statusCategory: String(issue.statusCategory || ''),
    assignee: issue.assignee ? String(issue.assignee) : null,
    priority: String(issue.priority || ''),
    labels: (issue.labels || []).map((l) => String(l).toLowerCase()),
    updatedAt: updated,
    lastCommentAt: lastComment,
    lastCommentBy: issue.lastCommentBy ? String(issue.lastCommentBy) : null,
    blocks: (issue.blocks || []).filter(Boolean).map(String),
    blockedBy: (issue.blockedBy || []).filter(Boolean).map(String),
    unmergedPrs: (issue.unmergedPrs || []).filter(Boolean).map((pr) => ({
      id: pr.id ? String(pr.id) : null,
      title: String(pr.title || ''),
      url: pr.url ? String(pr.url) : null,
      state: String(pr.state || 'OPEN'),
    })),
    goals: (issue.goals || []).filter(Boolean).map((g) =>
      typeof g === 'string' ? { title: g } : { title: String(g.title || '') },
    ),
  };
}

function isCustomerFacing(issue) {
  if (issue.labels.some((l) => CUSTOMER_MARKERS.some((m) => l.includes(m)))) return true;
  return ['blocker', 'highest', 'critical'].includes(issue.priority.toLowerCase());
}

function isQuiet(issue, now) {
  const last = Math.max(issue.updatedAt || 0, issue.lastCommentAt || 0);
  if (last === 0) return false;
  return daysSince(last, now) >= QUIET_DAYS;
}

function dateOrNull(value) {
  if (value === null || value === undefined) return null;
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function hoursSince(ts, now) {
  return (now - ts) / 3_600_000;
}

function daysSince(ts, now) {
  return (now - ts) / 86_400_000;
}

function countBy(values) {
  const out = {};
  for (const v of values) out[v] = (out[v] || 0) + 1;
  return out;
}

function capitalise(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
