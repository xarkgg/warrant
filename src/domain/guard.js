/**
 * Who is asking, and what are they allowed to say about themselves.
 *
 * Atlassian's own guidance for action handlers is blunt: "Your app should never
 * rely on values passed as inputs to perform critical checks like authorization.
 * If you need a user's accountId read it from the context." Payload values are
 * model-authored — an agent, or something pretending to be one, can put anything
 * in them. So:
 *
 *   - the caller's accountId comes from `context` and nowhere else;
 *   - a request payload is whitelisted down to intent before it is trusted;
 *   - nothing the payload says can pre-fill a grant, a limit that was not asked
 *     for, or a live warrant.
 *
 * Honest limit, stated in the docs rather than papered over: which Rovo agent
 * made a call is self-declared, because the platform does not pass a verified
 * agent identity to app functions. A warrant therefore binds the *operation,
 * scope, limits and expiry* — the things we can enforce — and treats the agent
 * name as a label for humans.
 */

const INTENT_FIELDS = [
  'operation',
  'issueKey',
  'issueKeys',
  'value',
  'jql',
  'reason',
  'maxActions',
  'ttlMinutes',
];

export function requireCaller(context) {
  const accountId = context && context.accountId;
  if (!accountId) {
    throw new Error('no authenticated caller: refusing to act on an unattributed request');
  }
  return String(accountId);
}

/** Only what an agent is allowed to ask for. Everything else is discarded. */
export function pickIntent(payload = {}) {
  const out = {};
  for (const field of INTENT_FIELDS) {
    if (payload[field] !== undefined && payload[field] !== null) out[field] = payload[field];
  }
  if (Array.isArray(out.issueKeys)) {
    out.issueKeys = out.issueKeys.filter((k) => typeof k === 'string');
  } else if (typeof out.issueKeys === 'string') {
    // Forge action inputs do not have an array type, so the manifest declares
    // this as a comma-separated string. Internal callers may still use arrays.
    out.issueKeys = out.issueKeys
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean);
  } else if (out.issueKeys !== undefined) {
    delete out.issueKeys;
  }
  return out;
}

/**
 * The actor recorded in the ledger. `onBehalfOf` is the verified human whose
 * permissions the write actually runs under; the agent name is a label.
 */
export function describeActor(payload = {}, context = {}) {
  const accountId = requireCaller(context);
  const label = typeof payload.agentName === 'string' ? payload.agentName.trim().slice(0, 80) : '';
  return {
    kind: 'agent',
    id: typeof payload.agentId === 'string' ? payload.agentId.trim().slice(0, 80) : 'rovo',
    name: label || 'Rovo agent',
    onBehalfOf: accountId,
  };
}

/** The human doing the granting, revoking or approving. Verified, not declared. */
export function describeHuman(context = {}) {
  const accountId = requireCaller(context);
  const name = (context.accountName || context.displayName || '').toString().trim();
  return { kind: 'user', id: accountId, name: name || 'A human' };
}
