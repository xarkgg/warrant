import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULTS,
  DENIAL,
  OPERATIONS,
  PHASE,
  STATE,
  consume,
  createRequest,
  describeScope,
  evaluate,
  grant,
  normalizeIssueKeys,
  phaseOf,
  remainingActions,
  revoke,
} from '../src/domain/warrant.js';
import { RISK, SIGNAL, buildBlastRadius } from '../src/domain/blast.js';
import { EVENT, UNDO, activity, createEvent, isUndoable, sortEvents, summarise, undoFor } from '../src/domain/ledger.js';
import { describeActor, pickIntent, requireCaller } from '../src/domain/guard.js';

const NOW = Date.parse('2026-11-20T10:00:00Z');
const MINUTE = 60_000;

function requested(overrides = {}) {
  return createRequest({
    id: 'w-1',
    agent: { kind: 'agent', id: 'rovo', name: 'Steward' },
    operation: OPERATIONS.TRANSITION,
    issueKeys: ['PROJ-3', 'PROJ-1', 'PROJ-1'],
    reason: 'close stale work',
    now: NOW,
    ...overrides,
  });
}

function signed(overrides = {}) {
  const result = grant(requested(), { by: 'acct-1', byName: 'Manass', now: NOW, ...overrides });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.warrant;
}

// ---------------------------------------------------------------------------
// The warrant
// ---------------------------------------------------------------------------

test('a request freezes and orders the issues it names', () => {
  const w = requested();
  assert.deepEqual(w.scope.issueKeys, ['PROJ-1', 'PROJ-3']);
  assert.equal(w.state, STATE.REQUESTED);
  assert.equal(w.limits.expiresAt, null);
  assert.equal(w.usage.used, 0);
});

test('a request refuses an unknown operation and an empty scope', () => {
  assert.throws(() => requested({ operation: 'jira.delete_project' }), /unknown operation/);
  assert.throws(() => requested({ issueKeys: [] }), /at least one issue/);
});

test('normalizeIssueKeys drops junk, dedupes and sorts numerically', () => {
  const keys = normalizeIssueKeys(['proj-10', 'PROJ-2', 'not a key', 'PROJ-2', '', 'ENG-1']);
  assert.deepEqual(keys, ['ENG-1', 'PROJ-2', 'PROJ-10']);
});

test('an unsigned warrant carries no authority', () => {
  const verdict = evaluate(requested(), { operation: OPERATIONS.TRANSITION, issueKey: 'PROJ-1', now: NOW });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, DENIAL.NOT_GRANTED);
});

test('a signed warrant allows a write inside its scope', () => {
  const w = signed();
  const verdict = evaluate(w, { operation: OPERATIONS.TRANSITION, issueKey: 'PROJ-3', now: NOW });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.phase, PHASE.ACTIVE);
  assert.equal(verdict.remaining, DEFAULTS.maxActions);
});

test('an issue that matches the original query but was not in the frozen list is refused', () => {
  // This is the whole point: a query is not a scope. PROJ-99 matched the JQL
  // yesterday, so the agent asks for it; it was never in the grant.
  const verdict = evaluate(signed(), {
    operation: OPERATIONS.TRANSITION,
    issueKey: 'PROJ-99',
    now: NOW,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, DENIAL.OUT_OF_SCOPE);
  assert.match(verdict.message, /not in this warrant/);
  assert.match(verdict.message, /frozen list/);
});

test('expiry is read from the clock, not swept by a job', () => {
  const w = signed({ ttlMinutes: 30 });
  assert.equal(phaseOf(w, NOW + 29 * MINUTE), PHASE.ACTIVE);
  const late = evaluate(w, { operation: OPERATIONS.TRANSITION, issueKey: 'PROJ-1', now: NOW + 31 * MINUTE });
  assert.equal(late.code, DENIAL.EXPIRED);
  // The stored state is untouched: nothing had to run for this to be true.
  assert.equal(w.state, STATE.GRANTED);
});

test('a warrant stops working when its action budget is spent', () => {
  let w = signed({ maxActions: 2, issueKeys: ['PROJ-1'] });
  w = consume(w, NOW);
  w = consume(w, NOW + 1);
  const verdict = evaluate(w, { operation: OPERATIONS.TRANSITION, issueKey: 'PROJ-1', now: NOW + 2 });
  assert.equal(verdict.code, DENIAL.EXHAUSTED);
  assert.equal(remainingActions(w), 0);
});

test('revocation is immediate and says who did it', () => {
  const w = revoke(signed(), { by: 'acct-1', byName: 'Manass', reason: 'wrong project', now: NOW }).warrant;
  const verdict = evaluate(w, { operation: OPERATIONS.TRANSITION, issueKey: 'PROJ-1', now: NOW });
  assert.equal(verdict.code, DENIAL.REVOKED);
  assert.match(verdict.message, /Manass/);
  assert.match(verdict.message, /wrong project/);
});

test('a warrant for one operation does not authorise another', () => {
  const verdict = evaluate(signed(), { operation: OPERATIONS.COMMENT, issueKey: 'PROJ-1', now: NOW });
  assert.equal(verdict.code, DENIAL.OPERATION_NOT_GRANTED);
});

test('nonsense targets are refused before anything is attempted', () => {
  const verdict = evaluate(signed(), { operation: OPERATIONS.TRANSITION, issueKey: 'DROP TABLE', now: NOW });
  assert.equal(verdict.code, DENIAL.BAD_TARGET);
});

test('no warrant at all is a refusal, not a crash', () => {
  assert.equal(evaluate(null, { operation: OPERATIONS.COMMENT, issueKey: 'PROJ-1' }).code, DENIAL.NO_WARRANT);
});

// ---------------------------------------------------------------------------
// Granting: narrow, never widen
// ---------------------------------------------------------------------------

test('a human can trim the scope and lower the limits', () => {
  const w = signed({ issueKeys: ['PROJ-1'], maxActions: 5, ttlMinutes: 60 });
  assert.deepEqual(w.scope.issueKeys, ['PROJ-1']);
  assert.equal(w.limits.maxActions, 5);
  assert.equal(Date.parse(w.limits.expiresAt), NOW + 60 * MINUTE);
  assert.equal(w.grant.trimmed, true);
});

test('a grant cannot add an issue the agent did not ask for', () => {
  const result = grant(requested(), {
    by: 'acct-1',
    byName: 'Manass',
    issueKeys: ['PROJ-1', 'PROJ-777'],
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'scope_widened');
  assert.deepEqual(result.detail, ['PROJ-777']);
});

test('a grant cannot raise the action cap or the ttl above what was asked', () => {
  const w = requested({ maxActions: 3, ttlMinutes: 15 });
  assert.equal(grant(w, { by: 'a', byName: 'A', maxActions: 30, now: NOW }).error, 'limit_widened');
  // A longer ttl than the agent asked for is refused, not silently shortened.
  assert.equal(grant(w, { by: 'a', byName: 'A', ttlMinutes: 600, now: NOW }).error, 'ttl_widened');
  const exact = grant(w, { by: 'a', byName: 'A', ttlMinutes: 15, maxActions: 3, now: NOW });
  assert.equal(exact.ok, true);
  assert.equal(exact.warrant.limits.maxActions, 3);
  assert.equal(Date.parse(exact.warrant.limits.expiresAt), NOW + 15 * MINUTE);
});

test('an emptied scope or a spent request cannot be granted', () => {
  assert.equal(grant(requested(), { by: 'a', byName: 'A', issueKeys: [], now: NOW }).error, 'empty_scope');
  assert.equal(grant(signed(), { by: 'a', byName: 'A', now: NOW }).error, 'not_requested');
});

test('describeScope reads like a sentence', () => {
  assert.equal(describeScope({ issueKeys: ['PROJ-1', 'PROJ-2'] }), '2 issues in PROJ');
  assert.equal(describeScope({ issueKeys: ['PROJ-1', 'ENG-4'] }), '2 issues across ENG, PROJ');
});

// ---------------------------------------------------------------------------
// Blast radius
// ---------------------------------------------------------------------------

const quiet = (key, extra = {}) => ({
  key,
  summary: `thing ${key}`,
  status: 'To Do',
  statusCategory: 'To Do',
  updatedAt: '2026-09-01T00:00:00Z',
  ...extra,
});

test('an empty or quiet set reads as low risk', () => {
  const empty = buildBlastRadius({ issues: [], now: NOW });
  assert.equal(empty.risk, RISK.LOW);
  assert.equal(empty.issueCount, 0);

  const calm = buildBlastRadius({ issues: [quiet('PROJ-1'), quiet('PROJ-2')], now: NOW });
  assert.equal(calm.risk, RISK.LOW);
  assert.equal(calm.against.length, 0);
  assert.match(calm.headline, /untouched for a month/);
});

test('code mid-flight and a live conversation push the read to high', () => {
  const blast = buildBlastRadius({
    issues: [
      quiet('PROJ-1', {
        unmergedPrs: [{ title: 'fix: null guard', state: 'OPEN', url: 'https://example.test/pr/1' }],
      }),
      quiet('PROJ-2', { lastCommentAt: '2026-11-20T06:00:00Z', lastCommentBy: 'Dana' }),
    ],
    now: NOW,
  });
  assert.equal(blast.risk, RISK.HIGH);
  // Equal-weight signals tie-break by code, so the order is deterministic.
  assert.deepEqual(
    blast.against.map((s) => s.code),
    [SIGNAL.ACTIVE_DISCUSSION, SIGNAL.UNMERGED_PR],
  );
  // Every claim points at the issues behind it.
  assert.deepEqual(blast.against[1].issueKeys, ['PROJ-1']);
  assert.match(blast.headline, /1 issue has code mid-flight/);
});

test('signals that argue for closing are kept separate from signals against', () => {
  const blast = buildBlastRadius({
    issues: [quiet('PROJ-1'), quiet('PROJ-2', { blocks: ['PROJ-5'] })],
    now: NOW,
  });
  assert.equal(blast.forIt[0].code, SIGNAL.QUIET);
  assert.equal(blast.forIt[0].weight < 0, true);
  assert.equal(blast.against[0].code, SIGNAL.BLOCKS_OTHERS);
  assert.equal(blast.risk, RISK.MEDIUM);
});

test('customer markers and linked goals are counted', () => {
  const blast = buildBlastRadius({
    issues: [
      quiet('PROJ-1', { labels: ['customer-reported'], goals: [{ title: 'Q4 reliability' }] }),
    ],
    now: NOW,
  });
  const codes = blast.against.map((s) => s.code);
  assert.ok(codes.includes(SIGNAL.CUSTOMER_FACING));
  assert.ok(codes.includes(SIGNAL.GOAL_AT_RISK));
});

test('building a blast radius does not mutate its input', () => {
  const issue = quiet('PROJ-1', { labels: ['Customer-Reported'] });
  const before = JSON.stringify(issue);
  buildBlastRadius({ issues: [issue], now: NOW });
  assert.equal(JSON.stringify(issue), before);
});

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

test('the ledger only accepts events it knows about', () => {
  assert.throws(() => createEvent({ id: 'e1', type: 'did_something', now: NOW }), /unknown ledger event/);
});

test('an executed transition records how to put it back', () => {
  const undo = undoFor(
    OPERATIONS.TRANSITION,
    { issueKey: 'PROJ-1', statusId: '1' },
    { issueKey: 'PROJ-1', statusId: '3' },
  );
  assert.deepEqual(undo, { kind: UNDO.TRANSITION, issueKey: 'PROJ-1', fromStatusId: '3', toStatusId: '1' });
  assert.equal(undoFor(OPERATIONS.TRANSITION, { statusId: '3' }, { statusId: '3' }), null);
});

test('a comment can be taken back and an assignment restored', () => {
  assert.deepEqual(undoFor(OPERATIONS.COMMENT, null, { issueKey: 'PROJ-1', commentId: 42 }), {
    kind: UNDO.COMMENT,
    issueKey: 'PROJ-1',
    commentId: '42',
  });
  assert.equal(undoFor(OPERATIONS.COMMENT, null, { issueKey: 'PROJ-1' }), null);
  const assign = undoFor(OPERATIONS.ASSIGN, { assigneeId: 'acct-9' }, { issueKey: 'PROJ-1', assigneeId: 'acct-2' });
  assert.equal(assign.toAssigneeId, 'acct-9');
  assert.equal(assign.fromAssigneeId, 'acct-2');
});

test('only a live executed write is undoable', () => {
  const done = createEvent({ id: 'e1', type: EVENT.EXECUTED, now: NOW, undo: { kind: UNDO.COMMENT, issueKey: 'P-1', commentId: '2' } });
  assert.equal(isUndoable(done), true);
  assert.equal(isUndoable({ ...done, undone: true }), false);
  assert.equal(isUndoable(createEvent({ id: 'e2', type: EVENT.BLOCKED, now: NOW })), false);
});

test('the stream sorts newest first and survives equal timestamps', () => {
  const a = createEvent({ id: 'e-a', type: EVENT.EXECUTED, now: NOW });
  const b = createEvent({ id: 'e-b', type: EVENT.BLOCKED, now: NOW });
  const c = createEvent({ id: 'e-c', type: EVENT.REQUESTED, now: NOW - MINUTE });
  assert.deepEqual(sortEvents([a, b, c]).map((e) => e.id), ['e-b', 'e-a', 'e-c']);
});

test('activity answers "what did it actually touch"', () => {
  const events = [
    createEvent({ id: '1', type: EVENT.EXECUTED, now: NOW, warrantId: 'w-1', issueKey: 'PROJ-1' }),
    createEvent({ id: '2', type: EVENT.BLOCKED, now: NOW, warrantId: 'w-1', issueKey: 'PROJ-99', code: 'OUT_OF_SCOPE' }),
    createEvent({ id: '3', type: EVENT.QUEUED, now: NOW, warrantId: 'w-1', issueKey: 'PROJ-98', code: 'OUT_OF_SCOPE' }),
    createEvent({ id: '4', type: EVENT.EXECUTED, now: NOW, warrantId: 'w-2', issueKey: 'ENG-4' }),
  ];
  const result = activity(events, 'w-1');
  assert.deepEqual(result.touched, ['PROJ-1']);
  assert.deepEqual(result.refused, ['PROJ-98', 'PROJ-99']);
  assert.equal(result.counts.blocked, 1);
  assert.equal(result.byCode.OUT_OF_SCOPE, 2);
  assert.equal(summarise(events).counts.executed, 2);
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test('an unattributed call is refused', () => {
  assert.throws(() => requireCaller({}), /no authenticated caller/);
  assert.throws(() => requireCaller(undefined), /no authenticated caller/);
  assert.equal(requireCaller({ accountId: 'acct-7' }), 'acct-7');
});

test('a payload cannot smuggle in a grant, a state or a caller', () => {
  const intent = pickIntent({
    operation: OPERATIONS.COMMENT,
    issueKeys: ['PROJ-1'],
    reason: 'summarise',
    state: 'granted',
    grant: { by: 'acct-evil' },
    usage: { used: 0 },
    limits: { maxActions: 100000, expiresAt: '2099-01-01T00:00:00Z' },
    accountId: 'acct-evil',
    grantedBy: 'acct-evil',
  });
  assert.deepEqual(Object.keys(intent).sort(), ['issueKeys', 'operation', 'reason']);
});

test('manifest-shaped comma-separated issue keys become an explicit list', () => {
  const intent = pickIntent({ issueKeys: ' PROJ-2,PROJ-1, PROJ-2 ' });
  assert.deepEqual(intent.issueKeys, ['PROJ-2', 'PROJ-1', 'PROJ-2']);
});

test('the recorded caller is the one in the context, not the one in the payload', () => {
  const actor = describeActor(
    { agentName: 'Steward', agentId: 'rovo', accountId: 'acct-evil' },
    { accountId: 'acct-real', accountName: 'Manass' },
  );
  assert.equal(actor.onBehalfOf, 'acct-real');
  assert.equal(actor.name, 'Steward');
});
