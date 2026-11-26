/**
 * The warrant: a scoped, expiring, revocable permission for an agent to write.
 *
 * This module is pure. No Forge imports, no I/O, no clock reads — callers pass
 * `now`. Every rule in here is unit-tested (tests/core.test.js).
 *
 * Two design decisions carry the product:
 *
 * 1. Scope is a frozen list of issue keys, never a query. A JQL string is an
 *    invitation to drift: a new issue matches tomorrow and the agent quietly
 *    gets authority nobody granted. We resolve the query once, at request time,
 *    store the resulting keys, and enforce against that list.
 *
 * 2. Expiry is *evaluated*, never swept. There is no background job that flips
 *    a row to "expired", so a missed tick cannot leave a stale warrant live.
 *    Storage only records intent (`requested | granted | revoked`); whether the
 *    warrant currently carries authority is derived from the clock.
 */

export const OPERATIONS = Object.freeze({
  TRANSITION: 'jira.transition',
  COMMENT: 'jira.comment',
  ASSIGN: 'jira.assign',
});

/** Human labels, also used by the agent surface so both read the same words. */
export const OPERATION_LABELS = Object.freeze({
  [OPERATIONS.TRANSITION]: 'Change status',
  [OPERATIONS.COMMENT]: 'Add a comment',
  [OPERATIONS.ASSIGN]: 'Assign an issue',
});

export const OPERATION_KEYS = Object.freeze(Object.values(OPERATIONS));

/** Stored state. Derived states (expired, exhausted) are never persisted. */
export const STATE = Object.freeze({
  REQUESTED: 'requested',
  GRANTED: 'granted',
  REVOKED: 'revoked',
});

/** What a reader sees: stored state resolved against the clock and usage. */
export const PHASE = Object.freeze({
  REQUESTED: 'requested',
  ACTIVE: 'active',
  EXPIRED: 'expired',
  EXHAUSTED: 'exhausted',
  REVOKED: 'revoked',
});

export const DENIAL = Object.freeze({
  NO_WARRANT: 'NO_WARRANT',
  NOT_GRANTED: 'NOT_GRANTED',
  REVOKED: 'REVOKED',
  EXPIRED: 'EXPIRED',
  EXHAUSTED: 'EXHAUSTED',
  OPERATION_NOT_GRANTED: 'OPERATION_NOT_GRANTED',
  OUT_OF_SCOPE: 'OUT_OF_SCOPE',
  BAD_TARGET: 'BAD_TARGET',
});

export const GRANT_ERROR = Object.freeze({
  NOT_REQUESTED: 'not_requested',
  EMPTY_SCOPE: 'empty_scope',
  SCOPE_WIDENED: 'scope_widened',
  LIMIT_WIDENED: 'limit_widened',
  TTL_WIDENED: 'ttl_widened',
  BAD_LIMIT: 'bad_limit',
  BAD_TTL: 'bad_ttl',
});

export const DEFAULTS = Object.freeze({
  maxActions: 25,
  ttlMinutes: 120,
  maxIssueKeys: 200,
  maxTtlMinutes: 60 * 24 * 14,
});

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

export function isValidIssueKey(key) {
  return typeof key === 'string' && ISSUE_KEY.test(key);
}

/** Sorted, de-duplicated, validated. Order is stable so digests are stable. */
export function normalizeIssueKeys(keys) {
  if (!Array.isArray(keys)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of keys) {
    const key = String(raw || '').trim().toUpperCase();
    if (!isValidIssueKey(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  out.sort((a, b) => {
    const [pa, na] = a.split('-');
    const [pb, nb] = b.split('-');
    if (pa !== pb) return pa < pb ? -1 : 1;
    return Number(na) - Number(nb);
  });
  return out.slice(0, DEFAULTS.maxIssueKeys);
}

export function projectsOf(issueKeys) {
  return [...new Set((issueKeys || []).map((k) => String(k).split('-')[0]))].sort();
}

/** A stable fingerprint of everything that materially defines the authority. */
export function fingerprint(warrant) {
  const parts = [
    warrant.request?.operation || '',
    ...(warrant.scope?.issueKeys || []),
    String(warrant.limits?.maxActions ?? ''),
  ];
  return parts.join('|');
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Resolve what this warrant currently is: requested, active, expired,
 * exhausted, or revoked. This is the only place the clock is consulted.
 */
export function phaseOf(warrant, now) {
  if (!warrant) return null;
  if (warrant.state === STATE.REVOKED) return PHASE.REVOKED;
  if (warrant.state !== STATE.GRANTED) return PHASE.REQUESTED;
  const expiresAt = warrant.limits?.expiresAt;
  if (!expiresAt || Date.parse(expiresAt) <= now) return PHASE.EXPIRED;
  if ((warrant.usage?.used || 0) >= (warrant.limits?.maxActions || 0)) {
    return PHASE.EXHAUSTED;
  }
  return PHASE.ACTIVE;
}

export function remainingActions(warrant) {
  if (!warrant || warrant.state !== STATE.GRANTED) return 0;
  const max = warrant.limits?.maxActions || 0;
  return Math.max(0, max - (warrant.usage?.used || 0));
}

export function millisecondsLeft(warrant, now) {
  const expiresAt = warrant.limits?.expiresAt;
  if (!expiresAt) return 0;
  return Math.max(0, Date.parse(expiresAt) - now);
}

// ---------------------------------------------------------------------------
// Creating a request
// ---------------------------------------------------------------------------

/**
 * An agent asking for authority. Nothing here grants anything: the warrant
 * lands in REQUESTED and stays inert until a human signs it.
 */
export function createRequest({
  id,
  agent,
  operation,
  issueKeys,
  jql = null,
  reason,
  maxActions = DEFAULTS.maxActions,
  ttlMinutes = DEFAULTS.ttlMinutes,
  now = Date.now(),
}) {
  if (!OPERATION_KEYS.includes(operation)) {
    throw new Error(`unknown operation: ${operation}`);
  }
  const keys = normalizeIssueKeys(issueKeys);
  if (keys.length === 0) {
    throw new Error('a warrant request must name at least one issue');
  }
  return {
    id,
    state: STATE.REQUESTED,
    agent: {
      kind: agent?.kind || 'agent',
      id: agent?.id || 'unknown',
      name: agent?.name || 'Unknown agent',
    },
    request: {
      operation,
      reason: String(reason || '').slice(0, 2000),
      requestedAt: new Date(now).toISOString(),
      askedMaxActions: clampInt(maxActions, 1, DEFAULTS.maxIssueKeys, DEFAULTS.maxActions),
      askedTtlMinutes: clampInt(ttlMinutes, 1, DEFAULTS.maxTtlMinutes, DEFAULTS.ttlMinutes),
    },
    scope: { issueKeys: keys },
    limits: { maxActions: 0, expiresAt: null },
    usage: { used: 0, lastUsedAt: null },
    grant: null,
    blast: null,
    source: { jql: jql ? String(jql).slice(0, 4000) : null },
  };
}

// ---------------------------------------------------------------------------
// Granting
// ---------------------------------------------------------------------------

/**
 * A human signing the warrant.
 *
 * A grant may narrow and may lower limits. It can never widen: the human cannot
 * hand the agent authority the agent did not ask for, which means the request
 * the agent printed in chat is the true ceiling of what was granted.
 */
export function grant(warrant, {
  by,
  byName,
  issueKeys = null,
  maxActions = null,
  ttlMinutes = null,
  now = Date.now(),
}) {
  if (!warrant || warrant.state !== STATE.REQUESTED) {
    return { ok: false, error: GRANT_ERROR.NOT_REQUESTED };
  }

  const asked = warrant.scope.issueKeys;
  const granted = issueKeys === null ? asked : normalizeIssueKeys(issueKeys);
  if (granted.length === 0) return { ok: false, error: GRANT_ERROR.EMPTY_SCOPE };

  const allowed = new Set(asked);
  const widened = granted.filter((k) => !allowed.has(k));
  if (widened.length > 0) {
    return { ok: false, error: GRANT_ERROR.SCOPE_WIDENED, detail: widened };
  }

  const requestedMax = warrant.request.askedMaxActions;
  let max = requestedMax;
  if (maxActions !== null) {
    max = Math.trunc(Number(maxActions));
    if (!Number.isInteger(max) || max < 1) return { ok: false, error: GRANT_ERROR.BAD_LIMIT };
    // Refuse rather than clamp: a silently reduced grant looks like a widening
    // to the person who typed the number.
    if (max > requestedMax) return { ok: false, error: GRANT_ERROR.LIMIT_WIDENED };
  }

  const requestedTtl = warrant.request.askedTtlMinutes;
  let ttl = requestedTtl;
  if (ttlMinutes !== null) {
    ttl = Math.trunc(Number(ttlMinutes));
    if (!Number.isInteger(ttl) || ttl < 1) return { ok: false, error: GRANT_ERROR.BAD_TTL };
    if (ttl > requestedTtl) return { ok: false, error: GRANT_ERROR.TTL_WIDENED };
  }

  return {
    ok: true,
    warrant: {
      ...warrant,
      state: STATE.GRANTED,
      scope: { issueKeys: granted },
      limits: {
        maxActions: max,
        expiresAt: new Date(now + ttl * 60_000).toISOString(),
      },
      grant: {
        by: String(by || ''),
        byName: String(byName || ''),
        at: new Date(now).toISOString(),
        ttlMinutes: ttl,
        trimmed: granted.length < asked.length,
      },
    },
  };
}

export function revoke(warrant, { by, byName, reason = '', now = Date.now() }) {
  if (!warrant) return { ok: false, error: 'missing' };
  if (warrant.state === STATE.REVOKED) return { ok: true, warrant };
  return {
    ok: true,
    warrant: {
      ...warrant,
      state: STATE.REVOKED,
      revocation: {
        by: String(by || ''),
        byName: String(byName || ''),
        reason: String(reason || '').slice(0, 500),
        at: new Date(now).toISOString(),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Enforcing
// ---------------------------------------------------------------------------

/**
 * The single check every write passes through.
 *
 * Order matters: the message a blocked agent relays to a human should name the
 * most specific reason, and the cheapest checks come first.
 */
export function evaluate(warrant, { operation, issueKey, now = Date.now() }) {
  if (!warrant) {
    return deny(DENIAL.NO_WARRANT, `No warrant covers ${operation}. Ask a human to grant one.`);
  }

  const phase = phaseOf(warrant, now);
  if (phase === PHASE.REVOKED) {
    return deny(
      DENIAL.REVOKED,
      `This warrant was revoked${warrant.revocation?.byName ? ` by ${warrant.revocation.byName}` : ''}${warrant.revocation?.reason ? `: ${warrant.revocation.reason}` : '.'}`,
    );
  }
  if (phase === PHASE.REQUESTED) {
    return deny(DENIAL.NOT_GRANTED, 'This warrant was requested but no human has signed it yet.');
  }
  if (phase === PHASE.EXPIRED) {
    return deny(
      DENIAL.EXPIRED,
      `This warrant expired at ${warrant.limits?.expiresAt}. Request a new one.`,
    );
  }
  if (phase === PHASE.EXHAUSTED) {
    return deny(
      DENIAL.EXHAUSTED,
      `This warrant allowed ${warrant.limits?.maxActions} actions and all of them are used.`,
    );
  }

  if (warrant.request.operation !== operation) {
    return deny(
      DENIAL.OPERATION_NOT_GRANTED,
      `This warrant covers ${warrant.request.operation}, not ${operation}.`,
    );
  }

  const key = String(issueKey || '').trim().toUpperCase();
  if (!isValidIssueKey(key)) {
    return deny(DENIAL.BAD_TARGET, `${issueKey} is not a Jira issue key. Nothing was attempted.`);
  }
  if (!warrant.scope.issueKeys.includes(key)) {
    return deny(
      DENIAL.OUT_OF_SCOPE,
      `${key} is not in this warrant, which covers ${warrant.scope.issueKeys.length} specific issue${warrant.scope.issueKeys.length === 1 ? '' : 's'} granted ${shortDate(warrant.grant?.at)}. It matches the original request but was not in the frozen list, so it needs its own grant.`,
      { phase },
    );
  }

  return { ok: true, phase, remaining: remainingActions(warrant) };
}

function deny(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

/** Record a consumed action. Returns a new warrant; never mutates. */
export function consume(warrant, now = Date.now()) {
  return {
    ...warrant,
    usage: {
      used: (warrant.usage?.used || 0) + 1,
      lastUsedAt: new Date(now).toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function shortDate(iso) {
  if (!iso) return 'earlier';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'earlier';
  return d.toISOString().slice(0, 10);
}

/** Compact phrase for UI and agent output: "12 issues across PROJ, ENG". */
export function describeScope(scope) {
  const keys = scope?.issueKeys || [];
  const projects = projectsOf(keys);
  const n = keys.length;
  const noun = n === 1 ? 'issue' : 'issues';
  if (projects.length === 0) return 'no issues';
  if (projects.length === 1) return `${n} ${noun} in ${projects[0]}`;
  return `${n} ${noun} across ${projects.join(', ')}`;
}
