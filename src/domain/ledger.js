/**
 * The ledger: one append-only stream of everything that happened to authority.
 *
 * Requests, grants, revocations, attempts, refusals, approvals and undos all
 * land in the same stream on purpose. An auditor asking "what did the agent do
 * with the authority we gave it" is answering a single ordered question, and
 * splitting grants from attempts across two tables is how that question gets
 * hard to answer later.
 *
 * Every executed write carries an undo descriptor, because "reversible" is the
 * difference between a permission and a commitment.
 */

export const EVENT = Object.freeze({
  REQUESTED: 'requested',
  GRANTED: 'granted',
  REVOKED: 'revoked',
  EXECUTED: 'executed',
  BLOCKED: 'blocked',
  QUEUED: 'queued',
  APPROVED: 'approved',
  DENIED: 'denied',
  UNDONE: 'undone',
  UNDO_FAILED: 'undo_failed',
});

export const UNDO = Object.freeze({
  TRANSITION: 'transition',
  COMMENT: 'comment',
  ASSIGN: 'assign',
});

/**
 * @param {object} input
 * @param {string} input.id
 * @param {string} input.type      one of EVENT
 * @param {number} [input.now]
 * @param {string} [input.warrantId]
 * @param {object} [input.actor]   {kind, id, name}
 * @param {string} [input.operation]
 * @param {string} [input.issueKey]
 * @param {string} [input.code]    denial code, if the event is a refusal
 * @param {string} [input.detail]  human-readable sentence
 * @param {object} [input.undo]    undo descriptor for executed writes
 * @param {object} [input.meta]
 */
export function createEvent({
  id,
  type,
  now = Date.now(),
  warrantId = null,
  actor = null,
  operation = null,
  issueKey = null,
  code = null,
  detail = '',
  undo = null,
  meta = null,
}) {
  if (!Object.values(EVENT).includes(type)) {
    throw new Error(`unknown ledger event: ${type}`);
  }
  return {
    id,
    at: new Date(now).toISOString(),
    type,
    warrantId,
    actor: actor
      ? {
          kind: String(actor.kind || 'unknown'),
          id: String(actor.id || ''),
          name: String(actor.name || ''),
        }
      : null,
    operation,
    issueKey: issueKey ? String(issueKey).toUpperCase() : null,
    code,
    detail: String(detail || '').slice(0, 500),
    undo: undo ? normaliseUndo(undo) : null,
    undone: false,
    meta: meta || null,
  };
}

/** Build the "how do I put this back" record alongside the write itself. */
export function undoFor(operation, before, after) {
  switch (operation) {
    case 'jira.transition':
      if (!before?.statusId || !after?.statusId || before.statusId === after.statusId) return null;
      return {
        kind: UNDO.TRANSITION,
        issueKey: after.issueKey,
        fromStatusId: after.statusId,
        toStatusId: before.statusId,
      };
    case 'jira.comment':
      if (!after?.commentId) return null;
      return { kind: UNDO.COMMENT, issueKey: after.issueKey, commentId: String(after.commentId) };
    case 'jira.assign':
      return {
        kind: UNDO.ASSIGN,
        issueKey: after?.issueKey || before?.issueKey,
        fromAssigneeId: after?.assigneeId || null,
        toAssigneeId: before?.assigneeId || null,
      };
    default:
      return null;
  }
}

function normaliseUndo(undo) {
  const kind = String(undo.kind || '');
  if (!Object.values(UNDO).includes(kind)) throw new Error(`unknown undo kind: ${kind}`);
  return { kind, issueKey: String(undo.issueKey || '').toUpperCase(), ...undo };
}

export function isUndoable(event) {
  return Boolean(event && event.undo && !event.undone && event.type === EVENT.EXECUTED);
}

/** Newest first, with a stable tiebreak so equal timestamps never reshuffle. */
export function sortEvents(events) {
  return [...events].sort((a, b) => {
    const delta = Date.parse(b.at) - Date.parse(a.at);
    if (delta !== 0) return delta;
    return String(b.id).localeCompare(String(a.id));
  });
}

export function summarise(events = []) {
  const counts = { executed: 0, blocked: 0, queued: 0, undone: 0 };
  const byCode = {};
  const byOperation = {};
  for (const e of events) {
    if (e.type === EVENT.EXECUTED) counts.executed += 1;
    if (e.type === EVENT.BLOCKED) counts.blocked += 1;
    if (e.type === EVENT.QUEUED) counts.queued += 1;
    if (e.type === EVENT.UNDONE) counts.undone += 1;
    if (e.code) byCode[e.code] = (byCode[e.code] || 0) + 1;
    if (e.operation) byOperation[e.operation] = (byOperation[e.operation] || 0) + 1;
  }
  return { counts, byCode, byOperation };
}

/**
 * The "what actually happened" half of the promise made at grant time: which
 * issues were touched, which were refused, and whether reality stayed inside
 * the blast radius the human was shown.
 */
export function activity(events = [], warrantId = null) {
  const scoped = warrantId ? events.filter((e) => e.warrantId === warrantId) : events;
  const touched = new Set();
  const refused = new Set();
  for (const e of scoped) {
    if (e.type === EVENT.EXECUTED && e.issueKey) touched.add(e.issueKey);
    if ((e.type === EVENT.BLOCKED || e.type === EVENT.QUEUED) && e.issueKey) refused.add(e.issueKey);
  }
  return {
    touched: [...touched].sort(),
    refused: [...refused].sort(),
    ...summarise(scoped),
  };
}
