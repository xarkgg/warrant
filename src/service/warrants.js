/**
 * The service layer.
 *
 * Everything above this file answers questions. Everything below it does I/O.
 * This is the only place where the two meet, and there is exactly one sequence
 * that turns authority into a change:
 *
 *   intent → authorise → execute → record → consume
 *
 * If a step is skipped the write does not happen, which is the property the
 * whole product rests on. Both entry points (`resolver` for the Custom UI,
 * `rovo` for the agent and MCP) call into these functions, so a warrant cannot
 * be dodged by approaching the app from a different door.
 */

import {
  OPERATION_KEYS,
  OPERATION_LABELS,
  OPERATIONS,
  PHASE,
  STATE,
  consume,
  createRequest,
  describeScope,
  grant,
  millisecondsLeft,
  phaseOf,
  remainingActions,
  revoke,
} from '../domain/warrant.js';
import { buildBlastRadius } from '../domain/blast.js';
import { EVENT, UNDO, createEvent, isUndoable, undoFor } from '../domain/ledger.js';
import { describeActor, describeHuman, pickIntent } from '../domain/guard.js';
import { defaultId } from '../store/store.js';
import * as jiraAdapter from '../platform/jira.js';
import * as twgAdapter from '../platform/twg.js';

/**
 * The platform is injected so the enforcement path can be tested against a
 * fake Jira. `index.js` passes nothing and gets the real adapters; the tests in
 * tests/service.test.js pass a recorder and assert that a refused write never
 * reaches the API at all.
 */
const REAL = { jira: jiraAdapter, twg: twgAdapter };

function platformOf(deps) {
  if (!deps) return REAL;
  return { jira: deps.jira || REAL.jira, twg: deps.twg || REAL.twg };
}

const GRANT_MESSAGE = {
  not_requested: 'That warrant is not waiting for a signature — it may already be signed, revoked, or gone.',
  empty_scope: 'A warrant with no issues grants nothing. Keep at least one.',
  scope_widened:
    'A grant can narrow the agent’s request, never widen it. Remove the issues the agent did not ask for.',
  limit_widened:
    'That is more actions than the agent asked for. Lower the ceiling, or deny this request and have the agent ask again.',
  ttl_widened:
    'That is longer than the agent asked to hold authority. Shorten it, or deny the request and have the agent ask again.',
  bad_limit: 'The action ceiling must be a whole number of at least 1.',
  bad_ttl: 'The expiry must be a whole number of minutes, at least 1.',
};

// ---------------------------------------------------------------------------
// Small things every surface shares
// ---------------------------------------------------------------------------

const MAX_REFRESH_KEYS = 25;

/**
 * A blast radius captured when the agent asked may be out of date by the time a
 * human signs — a pull request can be opened in between. Requests still awaiting
 * a signature get theirs recomputed from live Jira state, in one batched read.
 *
 * If that read fails the *stored* briefing survives, because showing the human
 * what the agent saw is better than showing them nothing.
 */
async function refreshRequestedBlasts(warrants, cloudId, deps) {
  const now = Date.now();
  const waiting = warrants.filter((w) => phaseOf(w, now) === PHASE.REQUESTED);
  if (waiting.length === 0) return warrants;

  const keys = [...new Set(waiting.flatMap((w) => w.scope.issueKeys))].slice(0, MAX_REFRESH_KEYS);
  if (keys.length === 0) return warrants;

  const { jira, twg } = platformOf(deps);
  let issues;
  try {
    issues = (await jira.getIssues(keys)).map(blastShape);
  } catch {
    return warrants;
  }

  if (twg.enabled()) {
    try {
      issues = (await twg.enrich(issues, cloudId)).issues;
    } catch {
      // A thinner briefing beats no briefing.
    }
  }

  const byKey = new Map(issues.map((issue) => [String(issue.key).toUpperCase(), issue]));
  return warrants.map((warrant) => {
    if (phaseOf(warrant, now) !== PHASE.REQUESTED) return warrant;
    const own = warrant.scope.issueKeys.map((key) => byKey.get(key)).filter(Boolean);
    if (own.length === 0) return warrant;
    return { ...warrant, blast: buildBlastRadius({ issues: own, now }) };
  });
}

/** Forge hands us the site id in different places depending on the module. */
export function cloudIdOf(context = {}) {
  if (context.cloudId) return String(context.cloudId);
  const raw = String(context.installContext || '');
  const match = raw.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  return match ? match[1] : null;
}

/** A warrant as a reader wants it: phase resolved, counts ready, words written. */
export function decorate(warrant, now = Date.now()) {
  const phase = phaseOf(warrant, now);
  return {
    ...warrant,
    phase,
    operation: warrant.request?.operation || null,
    operationLabel: OPERATION_LABELS[warrant.request?.operation] || 'Unknown operation',
    remaining: remainingActions(warrant),
    millisecondsLeft: millisecondsLeft(warrant, now),
    scopeSentence: describeScope(warrant.scope || {}),
    expiresIn: phase === PHASE.ACTIVE ? humanUntil(warrant.limits?.expiresAt, now) : null,
  };
}

function humanUntil(iso, now = Date.now()) {
  if (!iso) return 'no expiry';
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return 'an unknown time';
  if (ms <= 0) return 'already expired';
  return `in ${humanDuration(ms)}`;
}

function humanDuration(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : null;
}

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Reading context
// ---------------------------------------------------------------------------

/**
 * Comments are the only place a live conversation shows up, and fetching them
 * costs a request per issue, so this is bounded. An issue whose comments we did
 * not fetch keeps `lastCommentAt: null` — the signal stays silent rather than
 * guessing from `updated`, which would fire on any field edit.
 */
async function attachComments(jira, issues, { cap = 20, concurrency = 5 } = {}) {
  const queue = issues.slice(0, cap);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const issue = queue[index];
        if (!issue) return;
        try {
          const comments = await jira.getComments(issue.key, { limit: 50 });
          const latest = comments
            .slice()
            .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))[0];
          issue.lastCommentAt = latest?.createdAt || null;
          issue.lastCommentBy = latest?.authorName || null;
        } catch {
          // A user without comment permission still deserves a blast radius.
        }
      }
    }),
  );
  return issues;
}

function blastShape(issue) {
  return {
    ...issue,
    blocks: issue.links?.blocks || [],
    blockedBy: issue.links?.blockedBy || [],
  };
}

/**
 * Jira state plus graph state, shaped for the blast radius. Never throws on the
 * graph half: a site with Teamwork Graph off should still be able to grant a
 * warrant, just with a thinner briefing.
 */
async function loadContext(keys, cloudId, { commentCap = 20, deps = null } = {}) {
  const { jira, twg } = platformOf(deps);
  const issues = (await jira.getIssues(keys)).map(blastShape);
  await attachComments(jira, issues, { cap: commentCap });
  if (!twg.enabled()) return { issues, unavailable: 0 };
  const enriched = await twg.enrich(issues, cloudId);
  return { issues: enriched.issues, unavailable: enriched.unavailable };
}

// ---------------------------------------------------------------------------
// Writes. Each one returns what the ledger needs to reverse it.
// ---------------------------------------------------------------------------

function matchTransition(transitions, wanted) {
  const value = lower(wanted);
  return (
    transitions.find((t) => lower(t.name) === value) ||
    transitions.find((t) => lower(t.toStatusName) === value) ||
    transitions.find((t) => String(t.id) === String(wanted)) ||
    null
  );
}

/**
 * Resolve whatever the agent typed into an accountId. An agent that names a
 * person should not have to guess an opaque id, and an agent that has an
 * accountId should not cost a search call.
 */
async function resolveAssignee(jira, value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Assigning needs a person: an accountId or a display name.');
  if (/^[0-9a-f]{8,}(:[0-9a-f-]+)?$/i.test(raw) || raw.includes(':')) {
    return { accountId: raw, label: raw };
  }
  const users = await jira.searchUsers(raw);
  const hit = users.find((u) => u.active !== false);
  if (!hit) throw new Error(`Nobody on this site matches "${raw}".`);
  return { accountId: hit.accountId, label: hit.displayName || raw };
}

async function executeWrite({ jira }, { operation, issueKey, value }) {
  switch (operation) {
    case OPERATIONS.TRANSITION: {
      const before = await jira.getIssue(issueKey);
      const transitions = await jira.getTransitions(issueKey);
      const target = matchTransition(transitions, value);
      if (!target) {
        const options = transitions.map((t) => t.toStatusName).join(', ') || 'none';
        throw new Error(`"${value}" is not a status ${issueKey} can move to right now. Available: ${options}.`);
      }
      await jira.transition(issueKey, target.id);
      return {
        before,
        after: { issueKey, statusId: target.toStatusId },
        detail: `${issueKey} moved from ${before.status || 'its status'} to ${target.toStatusName || target.name}`,
      };
    }
    case OPERATIONS.COMMENT: {
      const text = String(value || '').trim();
      if (!text) throw new Error('A comment needs words.');
      const after = await jira.addComment(issueKey, text.slice(0, 20_000));
      return { before: null, after, detail: `Commented on ${issueKey}` };
    }
    case OPERATIONS.ASSIGN: {
      const before = await jira.getIssue(issueKey);
      const person = await resolveAssignee(jira, value);
      await jira.assign(issueKey, person.accountId);
      return {
        before,
        after: { issueKey, assigneeId: person.accountId },
        detail: `${issueKey} assigned to ${person.label}`,
      };
    }
    default:
      throw new Error(`The app does not know how to perform ${operation}.`);
  }
}

// ---------------------------------------------------------------------------
// Refusals are events
// ---------------------------------------------------------------------------

/**
 * Queue a refused write so the human who is already looking at this issue can
 * approve it. Duplicates are dropped: an agent retrying a refused write should
 * not fill the queue with the same sentence.
 */
async function queueRefusal({ store, warrant, verdict, intent, actor, now }) {
  if (verdict.code === 'BAD_TARGET') return null;
  const existing = await store.listPending({ status: 'pending', limit: 200 });
  const same = existing.find(
    (p) =>
      p.operation === intent.operation &&
      p.issueKey === String(intent.issueKey || '').toUpperCase() &&
      String(p.value || '') === String(intent.value || ''),
  );
  if (same) return same;
  return store.queuePending({
    warrantId: warrant?.id || null,
    operation: intent.operation,
    issueKey: String(intent.issueKey || '').toUpperCase(),
    value: intent.value,
    code: verdict.code,
    detail: verdict.message,
    actor,
    at: new Date(now).toISOString(),
  });
}

// ---------------------------------------------------------------------------
// The Custom UI surface
// ---------------------------------------------------------------------------

export async function snapshot({ store, context, deps = null }) {
  const now = Date.now();
  const [rawWarrants, pending, events] = await Promise.all([
    store.listWarrants({ limit: 200 }),
    store.listPending({ status: 'pending', limit: 100 }),
    store.listEvents({ limit: 120 }),
  ]);
  const current = await refreshRequestedBlasts(rawWarrants, cloudIdOf(context), deps);
  const decorated = current.map((w) => decorate(w, now));
  const counts = decorated.reduce(
    (acc, w) => {
      acc[w.phase] = (acc[w.phase] || 0) + 1;
      return acc;
    },
    { requested: 0, active: 0, expired: 0, exhausted: 0, revoked: 0 },
  );

  return {
    ok: true,
    at: new Date(now).toISOString(),
    viewer: describeHuman(context),
    warrants: decorated,
    pending,
    events,
    counts,
    // Is the graph even reachable? The console says "context is partial" rather
    // than implying there was nothing attached.
    graph: platformOf(deps).twg.enabled(),
  };
}

export async function issueContext({ store, context, input = {}, deps = null }) {
  const { jira, twg } = platformOf(deps);
  const now = Date.now();
  const issueKey = String(input.issueKey || '').trim().toUpperCase();
  if (!issueKey) return { ok: false, error: 'No issue key.' };

  const issue = await jira.getIssue(issueKey);
  const [comments, transitions, allWarrants, pending, events] = await Promise.all([
    jira.getComments(issueKey, { limit: 20 }).catch(() => []),
    jira.getTransitions(issueKey).catch(() => []),
    store.listWarrants({ limit: 200 }),
    store.listPending({ status: 'pending', limit: 100 }),
    store.listEvents({ limit: 200 }),
  ]);

  const latest = comments
    .slice()
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))[0];

  const shaped = {
    ...blastShape(issue),
    lastCommentAt: latest?.createdAt || null,
    lastCommentBy: latest?.authorName || null,
  };

  let withGraph = [shaped];
  let unavailable = 0;
  if (twg.enabled()) {
    const enriched = await twg.enrich([shaped], cloudIdOf(context));
    withGraph = enriched.issues;
    unavailable = enriched.unavailable;
  }

  return {
    ok: true,
    at: new Date(now).toISOString(),
    issue: {
      key: issue.key,
      summary: issue.summary,
      status: issue.status,
      statusCategory: issue.statusCategory,
      assignee: issue.assignee,
      priority: issue.priority,
      labels: issue.labels,
      updatedAt: issue.updatedAt,
      comments: latest
        ? { by: latest.authorName, at: latest.createdAt, excerpt: latest.body }
        : null,
    },
    transitions,
    blast: buildBlastRadius({ issues: withGraph, now }),
    unavailable,
    warrants: allWarrants
      .map((w) => decorate(w, now))
      .filter((w) => (w.scope?.issueKeys || []).includes(issueKey)),
    pending: pending.filter((p) => p.issueKey === issueKey),
    events: events.filter((e) => e.issueKey === issueKey).slice(0, 20),
    operations: OPERATION_KEYS.map((key) => ({ key, label: OPERATION_LABELS[key] })),
  };
}

export async function grantWarrant({ store, context, input = {} }) {
  const human = describeHuman(context);
  const now = Date.now();
  const warrant = await store.getWarrant(input.warrantId);
  if (!warrant) return { ok: false, error: 'That warrant no longer exists.' };

  const result = grant(warrant, {
    by: human.id,
    byName: human.name,
    issueKeys: Array.isArray(input.issueKeys) ? input.issueKeys : null,
    maxActions: numeric(input.maxActions),
    ttlMinutes: numeric(input.ttlMinutes),
    now,
  });

  if (!result.ok) {
    const detail = Array.isArray(result.detail) ? result.detail.join(', ') : null;
    return {
      ok: false,
      code: result.error,
      error: [GRANT_MESSAGE[result.error] || result.error, detail].filter(Boolean).join(' '),
    };
  }

  await store.putWarrant(result.warrant);
  await store.appendEvent(
    createEvent({
      id: defaultId('e'),
      type: EVENT.GRANTED,
      now,
      warrantId: warrant.id,
      actor: human,
      operation: warrant.request.operation,
      detail: `${human.name} signed ${describeScope(result.warrant.scope)} for up to ${
        result.warrant.limits.maxActions
      } actions, ${humanUntil(result.warrant.limits.expiresAt, now)}`,
      meta: {
        issueKeys: result.warrant.scope.issueKeys,
        maxActions: result.warrant.limits.maxActions,
        ttlMinutes: result.warrant.grant.ttlMinutes,
        trimmed: result.warrant.grant.trimmed,
      },
    }),
  );

  return { ok: true, warrant: decorate(result.warrant, now) };
}

/**
 * Declining a request before it is signed.
 *
 * This is not a revocation, and the ledger should not read like one: nothing was
 * ever in force. The record keeps the stored state machine honest (the request
 * can never be signed afterwards, because `grant` only accepts `requested`) while
 * the event says plainly that a human said no.
 */
export async function declineRequest({ store, context, input = {} }) {
  const human = describeHuman(context);
  const now = Date.now();
  const warrant = await store.getWarrant(input.warrantId);
  if (!warrant) return { ok: false, error: 'That request no longer exists.' };
  if (warrant.state !== STATE.REQUESTED) {
    return {
      ok: false,
      error: 'That warrant is already signed. Revoke it instead, so the ledger shows authority being taken back.',
    };
  }

  const result = revoke(warrant, {
    by: human.id,
    byName: human.name,
    reason: 'declined before signing',
    now,
  });
  await store.putWarrant(result.warrant);
  await store.appendEvent(
    createEvent({
      id: defaultId('e'),
      type: EVENT.DENIED,
      now,
      warrantId: warrant.id,
      actor: human,
      operation: warrant.request?.operation || null,
      detail: `${human.name} declined ${warrant.agent?.name || 'the agent'}'s request on ${describeScope(
        warrant.scope,
      )}`,
    }),
  );
  return { ok: true, warrant: decorate(result.warrant, now) };
}

export async function revokeWarrant({ store, context, input = {} }) {
  const human = describeHuman(context);
  const now = Date.now();
  const warrant = await store.getWarrant(input.warrantId);
  if (!warrant) return { ok: false, error: 'That warrant no longer exists.' };

  const result = revoke(warrant, {
    by: human.id,
    byName: human.name,
    reason: input.reason || '',
    now,
  });
  await store.putWarrant(result.warrant);
  await store.appendEvent(
    createEvent({
      id: defaultId('e'),
      type: EVENT.REVOKED,
      now,
      warrantId: warrant.id,
      actor: human,
      operation: warrant.request?.operation || null,
      detail: `${human.name} revoked this warrant${
        input.reason ? `: ${String(input.reason).slice(0, 200)}` : ''
      }`,
    }),
  );
  return { ok: true, warrant: decorate(result.warrant, now) };
}

export async function resolvePending({ store, context, input = {}, deps = null }) {
  const { jira } = platformOf(deps);
  const human = describeHuman(context);
  const now = Date.now();
  const record = await store.getPending(input.pendingId);
  if (!record) return { ok: false, error: 'That queued change is gone.' };
  if (record.status !== 'pending') {
    return { ok: false, error: `That queued change was already ${record.status}.` };
  }

  if (input.decision === 'deny') {
    const denied = await store.resolvePending(record.id, {
      status: 'denied',
      by: human.id,
      byName: human.name,
      now,
    });
    await store.appendEvent(
      createEvent({
        id: defaultId('e'),
        type: EVENT.DENIED,
        now,
        warrantId: record.warrantId,
        actor: human,
        operation: record.operation,
        issueKey: record.issueKey,
        code: record.code,
        detail: `${human.name} declined the queued change on ${record.issueKey}`,
      }),
    );
    return { ok: true, pending: denied };
  }

  // Approving is the human supplying the authority the warrant withheld, for
  // this one write. It does not extend the warrant.
  try {
    const result = await executeWrite({ jira }, record);
    await store.resolvePending(record.id, {
      status: 'approved',
      by: human.id,
      byName: human.name,
      now,
    });
    await store.appendEvent(
      createEvent({
        id: defaultId('e'),
        type: EVENT.EXECUTED,
        now,
        warrantId: record.warrantId,
        actor: human,
        operation: record.operation,
        issueKey: record.issueKey,
        detail: `${result.detail} (approved by ${human.name} from the queue)`,
        undo: undoFor(record.operation, result.before, result.after),
        meta: { via: 'approval', pendingId: record.id, agent: record.actor || null },
      }),
    );
    return { ok: true, executed: result.detail };
  } catch (error) {
    await store.resolvePending(record.id, {
      status: 'failed',
      by: human.id,
      byName: human.name,
      now,
    });
    await store.appendEvent(
      createEvent({
        id: defaultId('e'),
        type: EVENT.BLOCKED,
        now,
        warrantId: record.warrantId,
        actor: human,
        operation: record.operation,
        issueKey: record.issueKey,
        code: 'EXECUTION_FAILED',
        detail: `Approved, but Jira refused it: ${error.message}`,
      }),
    );
    return { ok: false, error: `Jira refused the change: ${error.message}` };
  }
}

export async function undo({ store, context, input = {}, deps = null }) {
  const { jira } = platformOf(deps);
  const human = describeHuman(context);
  const now = Date.now();
  const events = await store.listEvents({ limit: 500 });
  const event = events.find((e) => e.id === input.eventId);
  if (!event) return { ok: false, error: 'That entry is not in the ledger.' };
  if (!isUndoable(event)) {
    return { ok: false, error: 'That entry cannot be undone — it was a refusal, already undone, or has no recorded inverse.' };
  }

  try {
    switch (event.undo.kind) {
      case UNDO.TRANSITION: {
        const transitions = await jira.getTransitions(event.undo.issueKey);
        const back = transitions.find((t) => String(t.toStatusId) === String(event.undo.toStatusId));
        if (!back) {
          throw new Error(
            `${event.undo.issueKey} can no longer move back to that status from where it is now.`,
          );
        }
        await jira.transition(event.undo.issueKey, back.id);
        break;
      }
      case UNDO.COMMENT:
        await jira.deleteComment(event.undo.issueKey, event.undo.commentId);
        break;
      case UNDO.ASSIGN:
        await jira.assign(event.undo.issueKey, event.undo.toAssigneeId);
        break;
      default:
        throw new Error(`No inverse is implemented for ${event.undo.kind}.`);
    }
  } catch (error) {
    await store.appendEvent(
      createEvent({
        id: defaultId('e'),
        type: EVENT.UNDO_FAILED,
        now,
        warrantId: event.warrantId,
        actor: human,
        operation: event.operation,
        issueKey: event.issueKey,
        code: 'UNDO_FAILED',
        detail: `${human.name} tried to undo ${event.id} and could not: ${error.message}`,
      }),
    );
    return { ok: false, error: error.message };
  }

  await store.markUndone(event.id, event.warrantId);
  await store.appendEvent(
    createEvent({
      id: defaultId('e'),
      type: EVENT.UNDONE,
      now,
      warrantId: event.warrantId,
      actor: human,
      operation: event.operation,
      issueKey: event.issueKey,
      detail: `${human.name} put ${event.issueKey} back`,
      meta: { undoneEventId: event.id },
    }),
  );
  return { ok: true };
}

/**
 * A human proposing work from the issue panel. It creates a *request*, not a
 * permission, exactly like the agent's path — the same card appears in the
 * console and the same narrowing rule applies when it is signed.
 */
export async function requestForIssue({ store, context, input = {}, deps = null }) {
  const human = describeHuman(context);
  const now = Date.now();
  const issueKey = String(input.issueKey || '').trim().toUpperCase();
  const operation = String(input.operation || '');

  if (!OPERATION_KEYS.includes(operation)) {
    return { ok: false, error: `Choose one of: ${OPERATION_KEYS.join(', ')}.` };
  }

  const { issues, unavailable } = await loadContext([issueKey], cloudIdOf(context), {
    commentCap: 1,
    deps,
  });
  const request = createRequest({
    id: defaultId('w'),
    agent: { kind: 'agent', id: 'rovo', name: 'Steward' },
    operation,
    issueKeys: [issueKey],
    jql: null,
    reason: input.reason || `Proposed from ${issueKey} by ${human.name}`,
    maxActions: numeric(input.maxActions) ?? 10,
    ttlMinutes: numeric(input.ttlMinutes) ?? 120,
    now,
  });
  request.blast = buildBlastRadius({ issues, now });
  request.source.proposedBy = human;

  await store.putWarrant(request);
  await store.appendEvent(
    createEvent({
      id: defaultId('e'),
      type: EVENT.REQUESTED,
      now,
      warrantId: request.id,
      actor: human,
      operation,
      issueKey,
      detail: `${human.name} proposed ${OPERATION_LABELS[operation]} on ${issueKey}`,
    }),
  );

  return { ok: true, warrant: decorate(request, now), unavailable };
}

// ---------------------------------------------------------------------------
// The agent surface. These return sentences, because an agent relays them.
// ---------------------------------------------------------------------------

export async function requestWarrant({ store, payload = {}, context = {}, deps = null }) {
  const { jira } = platformOf(deps);
  const actor = describeActor(payload, context);
  const now = Date.now();
  const intent = pickIntent(payload);
  const operation = String(intent.operation || '');

  if (!OPERATION_KEYS.includes(operation)) {
    return `I need an operation: one of ${OPERATION_KEYS.join(', ')}.`;
  }

  let keys = [];
  let jql = null;
  if (intent.jql) {
    jql = String(intent.jql);
    try {
      keys = await jira.searchKeys(jql, { limit: 200 });
    } catch (error) {
      return `That query was rejected by Jira, so nothing was requested: ${error.message}`;
    }
    if (keys.length === 0) {
      return `That query matches no issues right now, so there is nothing to grant. Nothing was created.`;
    }
  }
  if (keys.length === 0 && Array.isArray(intent.issueKeys)) keys = intent.issueKeys;

  let request;
  try {
    request = createRequest({
      id: defaultId('w'),
      agent: { kind: 'agent', id: actor.id, name: actor.name },
      operation,
      issueKeys: keys,
      jql,
      reason: intent.reason,
      maxActions: numeric(intent.maxActions) ?? undefined,
      ttlMinutes: numeric(intent.ttlMinutes) ?? undefined,
      now,
    });
  } catch (error) {
    return `${error.message}. Nothing was requested.`;
  }

  const { issues, unavailable } = await loadContext(
    request.scope.issueKeys,
    cloudIdOf(context),
    { deps },
  );
  request.blast = buildBlastRadius({ issues, now });

  await store.putWarrant(request);
  await store.appendEvent(
    createEvent({
      id: defaultId('e'),
      type: EVENT.REQUESTED,
      now,
      warrantId: request.id,
      actor,
      operation,
      detail: `${actor.name} asked to ${OPERATION_LABELS[operation].toLowerCase()} on ${describeScope(
        request.scope,
      )}`,
    }),
  );

  const blast = request.blast;
  const partial = unavailable > 0 ? ` Context is partial: ${unavailable} graph calls failed.` : '';

  return [
    `Requested a warrant for ${OPERATION_LABELS[operation].toLowerCase()} on ${describeScope(request.scope)}.`,
    `Nothing has happened yet — a human has to sign it in the Warrant console.`,
    `Request id: ${request.id}. Ceiling asked: ${request.request.askedMaxActions} actions, ${request.request.askedTtlMinutes} minutes.`,
    `What a reviewer will see: ${blast.headline} (risk: ${blast.risk}).${partial}`,
  ].join(' ');
}

export async function checkWarrant({ store, payload = {}, context = {} }) {
  const actor = describeActor(payload, context);
  const now = Date.now();
  const intent = pickIntent(payload);
  const operation = String(intent.operation || '');
  const issueKey = String(intent.issueKey || '').trim().toUpperCase();

  if (!OPERATION_KEYS.includes(operation)) {
    return `I need an operation: one of ${OPERATION_KEYS.join(', ')}.`;
  }
  if (!issueKey) return 'I need an issue key to check.';

  const auth = await store.authorise({ operation, issueKey, agentId: actor.id });
  if (auth.ok) {
    const w = auth.warrant;
    return `Yes. Warrant ${w.id} covers ${OPERATION_LABELS[operation].toLowerCase()} on ${issueKey}. ${remainingActions(
      w,
    )} of ${w.limits.maxActions} actions left, expiring ${humanUntil(w.limits.expiresAt, now)}.`;
  }

  const verdict = auth.verdict;
  const suffix =
    verdict.code === 'NO_WARRANT'
      ? ' Ask a human for a warrant before trying again.'
      : ' A human can grant or extend it in the Warrant console.';
  return `No. ${verdict.message}${suffix}`;
}

export async function performChange({ store, payload = {}, context = {}, deps = null }) {
  const { jira } = platformOf(deps);
  const actor = describeActor(payload, context);
  const now = Date.now();
  const intent = pickIntent(payload);
  const operation = String(intent.operation || '');
  const issueKey = String(intent.issueKey || '').trim().toUpperCase();

  if (!OPERATION_KEYS.includes(operation)) {
    return `I need an operation: one of ${OPERATION_KEYS.join(', ')}. Nothing was attempted.`;
  }
  if (!issueKey) return 'I need an issue key. Nothing was attempted.';
  if (intent.value === undefined || intent.value === null || intent.value === '') {
    return `I need a value for ${OPERATION_LABELS[operation].toLowerCase()}. Nothing was attempted.`;
  }

  const auth = await store.authorise({ operation, issueKey, agentId: actor.id });

  if (!auth.ok) {
    const verdict = auth.verdict;
    const queued = await queueRefusal({
      store,
      warrant: auth.warrant,
      verdict,
      intent: { ...intent, issueKey },
      actor,
      now,
    });
    await store.appendEvent(
      createEvent({
        id: defaultId('e'),
        type: EVENT.BLOCKED,
        now,
        warrantId: auth.warrant?.id || null,
        actor,
        operation,
        issueKey,
        code: verdict.code,
        detail: verdict.message,
        meta: queued ? { pendingId: queued.id } : null,
      }),
    );
    const tail = queued
      ? ` It is now queued for a human to approve in the Warrant console.`
      : '';
    return `Refused, and nothing was changed. ${verdict.message}${tail}`;
  }

  try {
    const result = await executeWrite({ jira }, { operation, issueKey, value: intent.value });
    const updated = consume(auth.warrant, now);
    await store.putWarrant(updated);
    await store.appendEvent(
      createEvent({
        id: defaultId('e'),
        type: EVENT.EXECUTED,
        now,
        warrantId: auth.warrant.id,
        actor,
        operation,
        issueKey,
        detail: result.detail,
        undo: undoFor(operation, result.before, result.after),
        meta: { remainingAfter: remainingActions(updated) },
      }),
    );
    return `Done. ${result.detail}. ${remainingActions(updated)} of ${
      updated.limits.maxActions
    } actions left on warrant ${updated.id}, expiring ${humanUntil(updated.limits.expiresAt, now)}. A human can undo this from the console.`;
  } catch (error) {
    await store.appendEvent(
      createEvent({
        id: defaultId('e'),
        type: EVENT.BLOCKED,
        now,
        warrantId: auth.warrant.id,
        actor,
        operation,
        issueKey,
        code: 'EXECUTION_FAILED',
        detail: error.message,
      }),
    );
    return `The warrant allowed it but the write failed, so nothing was changed: ${error.message}`;
  }
}

export async function listWarrants({ store, payload = {}, context = {} }) {
  const now = Date.now();
  const [warrants, pending] = await Promise.all([
    store.listWarrants({ limit: 50 }),
    store.listPending({ status: 'pending', limit: 50 }),
  ]);

  if (warrants.length === 0 && pending.length === 0) {
    return 'There are no warrants on this site. You currently hold no authority, which means every write will be refused.';
  }

  const lines = warrants.slice(0, 12).map((w) => {
    const d = decorate(w, now);
    const state =
      d.phase === PHASE.ACTIVE
        ? `active, ${d.remaining} of ${d.limits?.maxActions ?? 0} actions left, expires ${d.expiresIn}`
        : d.phase;
    return `- ${d.id}: ${d.operationLabel} on ${d.scopeSentence} — ${state}`;
  });

  const tail =
    pending.length > 0
      ? ` ${pending.length} change${pending.length === 1 ? '' : 's'} were refused and are waiting for a human in the console.`
      : '';
  return [`Warrants (${warrants.length}):`, ...lines].join('\n') + tail;
}
