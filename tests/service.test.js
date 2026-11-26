import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore, memoryDriver } from '../src/store/store.js';
import * as service from '../src/service/warrants.js';
import { OPERATIONS, PHASE } from '../src/domain/warrant.js';
import { EVENT } from '../src/domain/ledger.js';

const HUMAN = { accountId: 'acct-human', accountName: 'Manass', cloudId: 'cloud-1' };
const AGENT = { accountId: 'acct-human', cloudId: 'cloud-1' };

/**
 * A Jira that remembers every write attempt. The point of the refusals below is
 * that `writes` stays empty: a refused change must never reach the API.
 */
function fakeJira(seed = {}) {
  const issues = new Map(
    Object.entries({
      'PROJ-1': {
        id: '10001',
        key: 'PROJ-1',
        summary: 'Login form drops focus',
        status: 'In Progress',
        statusId: '3',
        statusCategory: 'In Progress',
        assignee: 'Dana',
        assigneeId: 'acct-dana',
        priority: 'Medium',
        labels: ['stale'],
        updatedAt: '2026-09-01T00:00:00Z',
        links: { blocks: [], blockedBy: [] },
        ...(seed['PROJ-1'] || {}),
      },
      'PROJ-2': {
        id: '10002',
        key: 'PROJ-2',
        summary: 'Export times out',
        status: 'To Do',
        statusId: '1',
        statusCategory: 'To Do',
        assignee: null,
        assigneeId: null,
        priority: 'High',
        labels: [],
        updatedAt: '2026-08-01T00:00:00Z',
        links: { blocks: [], blockedBy: [] },
        ...(seed['PROJ-2'] || {}),
      },
    }),
  );

  const writes = [];
  let commentSeq = 500;

  return {
    writes,
    issues,
    async getIssues(keys) {
      return keys.map((k) => ({ ...issues.get(String(k).toUpperCase()) })).filter(Boolean);
    },
    async getIssue(key) {
      const issue = issues.get(String(key).toUpperCase());
      if (!issue) throw new Error(`Jira 404 for ${key}`);
      return { ...issue };
    },
    async getComments() {
      return [];
    },
    async getTransitions(key) {
      const issue = issues.get(String(key).toUpperCase());
      if (issue?.status === 'Done') return [];
      return [{ id: '11', name: 'Done', toStatusId: '10000', toStatusName: 'Done' }];
    },
    async searchUsers() {
      return [{ accountId: 'acct-dana', displayName: 'Dana', active: true }];
    },
    async searchKeys() {
      return [];
    },
    async transition(key, id) {
      writes.push({ kind: 'transition', key, id });
      return { issueKey: key, statusId: null };
    },
    async addComment(key, text) {
      commentSeq += 1;
      writes.push({ kind: 'comment', key, text, commentId: String(commentSeq) });
      return { issueKey: key, commentId: String(commentSeq) };
    },
    async deleteComment(key, id) {
      writes.push({ kind: 'deleteComment', key, id });
      return { issueKey: key, commentId: id };
    },
    async assign(key, accountId) {
      writes.push({ kind: 'assign', key, accountId });
      return { issueKey: key, assigneeId: accountId };
    },
  };
}

const fakeTwg = { enabled: () => false, enrich: async (issues) => ({ issues, unavailable: 0 }) };

function harness(seed) {
  const jira = fakeJira(seed);
  const store = createStore(memoryDriver());
  const deps = { jira, twg: fakeTwg };
  return { jira, store, deps };
}

async function latestRequest(store) {
  const list = await store.listWarrants({ limit: 10 });
  return list[0];
}

// ---------------------------------------------------------------------------

test('an agent cannot create a signed warrant by claiming one in the payload', async () => {
  const { store, deps } = harness();
  await service.requestWarrant({
    store,
    deps,
    context: AGENT,
    payload: {
      operation: OPERATIONS.TRANSITION,
      issueKeys: ['PROJ-1'],
      reason: 'close it',
      state: 'granted',
      grant: { by: 'acct-human' },
      limits: { maxActions: 9999, expiresAt: '2099-01-01T00:00:00Z' },
    },
  });
  const request = await latestRequest(store);
  assert.equal(request.state, 'requested');
  assert.equal(request.grant, null);
  assert.deepEqual(request.scope.issueKeys, ['PROJ-1']);
});

test('a Rovo request accepts the manifest comma-separated issue-key input', async () => {
  const { store, deps } = harness();
  const answer = await service.requestWarrant({
    store,
    deps,
    context: AGENT,
    payload: {
      operation: OPERATIONS.COMMENT,
      issueKeys: 'PROJ-2, PROJ-1',
      reason: 'Leave one test comment on each issue',
      maxActions: 2,
      ttlMinutes: 30,
    },
  });

  assert.match(answer, /Requested a warrant/);
  const request = await latestRequest(store);
  assert.deepEqual(request.scope.issueKeys, ['PROJ-1', 'PROJ-2']);
});

test('a request records the blast radius the human will be shown', async () => {
  const { store, deps } = harness({
    'PROJ-1': { unmergedPrs: [], updatedAt: '2026-09-01T00:00:00Z' },
  });
  await service.requestWarrant({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.TRANSITION, issueKeys: ['PROJ-1', 'PROJ-2'], reason: 'tidy' },
  });
  const request = await latestRequest(store);
  assert.ok(request.blast);
  assert.equal(request.blast.issueCount, 2);
  assert.match(request.blast.headline, /issue/i);
});

test('a write with no warrant is refused and never reaches Jira', async () => {
  const { jira, store, deps } = harness();
  const answer = await service.performChange({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.TRANSITION, issueKey: 'PROJ-1', value: 'Done' },
  });
  assert.match(answer, /Refused/);
  assert.equal(jira.writes.length, 0);
  // The refusal is an event, and it waits in the queue for a human.
  const events = await store.listEvents();
  assert.equal(events[0].type, EVENT.BLOCKED);
  assert.equal(events[0].code, 'NO_WARRANT');
  const pending = await store.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].issueKey, 'PROJ-1');
});

test('the full loop: request, sign, enforce, consume, undo', async () => {
  const { jira, store, deps } = harness();

  await service.requestWarrant({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.COMMENT, issueKeys: ['PROJ-1'], reason: 'note the cause' },
  });
  const request = await latestRequest(store);

  const signed = await service.grantWarrant({
    store,
    context: HUMAN,
    input: { warrantId: request.id, maxActions: 2 },
  });
  assert.equal(signed.ok, true);
  assert.equal(signed.warrant.phase, PHASE.ACTIVE);
  assert.equal(signed.warrant.limits.maxActions, 2);

  const done = await service.performChange({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.COMMENT, issueKey: 'PROJ-1', value: 'The cause is the debounce.' },
  });
  assert.match(done, /^Done\./);
  assert.equal(jira.writes.length, 1);
  assert.equal(jira.writes[0].kind, 'comment');

  const after = await store.getWarrant(request.id);
  assert.equal(after.usage.used, 1);

  const executed = (await store.listEvents()).find((e) => e.type === EVENT.EXECUTED);
  assert.equal(executed.issueKey, 'PROJ-1');
  assert.equal(executed.undo.kind, 'comment');

  const undone = await service.undo({ store, deps, context: HUMAN, input: { eventId: executed.id } });
  assert.equal(undone.ok, true);
  assert.equal(jira.writes[1].kind, 'deleteComment');
  assert.equal(jira.writes[1].id, executed.undo.commentId);
});

test('a write outside the frozen list is refused and queued, not attempted', async () => {
  const { jira, store, deps } = harness();
  await service.requestWarrant({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.TRANSITION, issueKeys: ['PROJ-1'], reason: 'close' },
  });
  const request = await latestRequest(store);
  await service.grantWarrant({ store, context: HUMAN, input: { warrantId: request.id } });

  const answer = await service.performChange({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.TRANSITION, issueKey: 'PROJ-2', value: 'Done' },
  });
  assert.match(answer, /OUT_OF_SCOPE|not in this warrant/);
  assert.equal(jira.writes.length, 0);
  assert.equal((await store.listPending()).length, 1);
});

test('a spent budget refuses the next write without touching Jira', async () => {
  const { jira, store, deps } = harness();
  await service.requestWarrant({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.TRANSITION, issueKeys: ['PROJ-1'], reason: 'close', maxActions: 1 },
  });
  const request = await latestRequest(store);
  await service.grantWarrant({ store, context: HUMAN, input: { warrantId: request.id, maxActions: 1 } });

  const first = await service.performChange({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.TRANSITION, issueKey: 'PROJ-1', value: 'Done' },
  });
  assert.match(first, /^Done\./);
  assert.equal(jira.writes.length, 1);

  const second = await service.performChange({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.TRANSITION, issueKey: 'PROJ-1', value: 'Done' },
  });
  assert.match(second, /all of them are used|EXHAUSTED/i);
  assert.equal(jira.writes.length, 1);
});

test('a grant cannot widen what the agent asked for', async () => {
  const { store, deps } = harness();
  await service.requestWarrant({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.TRANSITION, issueKeys: ['PROJ-1'], reason: 'close', maxActions: 2 },
  });
  const request = await latestRequest(store);

  const moreIssues = await service.grantWarrant({
    store,
    context: HUMAN,
    input: { warrantId: request.id, issueKeys: ['PROJ-1', 'PROJ-2'] },
  });
  assert.equal(moreIssues.ok, false);
  assert.match(moreIssues.error, /never widen/);

  const moreActions = await service.grantWarrant({
    store,
    context: HUMAN,
    input: { warrantId: request.id, maxActions: 50 },
  });
  assert.equal(moreActions.ok, false);

  const longerTtl = await service.grantWarrant({
    store,
    context: HUMAN,
    input: { warrantId: request.id, ttlMinutes: 60 * 24 * 30 },
  });
  assert.equal(longerTtl.ok, false);

  // Still unsigned after all of that.
  assert.equal((await store.getWarrant(request.id)).state, 'requested');
});

test('a human can trim the grant down to one issue', async () => {
  const { store, deps } = harness();
  await service.requestWarrant({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.COMMENT, issueKeys: ['PROJ-1', 'PROJ-2'], reason: 'note' },
  });
  const request = await latestRequest(store);
  const signed = await service.grantWarrant({
    store,
    context: HUMAN,
    input: { warrantId: request.id, issueKeys: ['PROJ-1'] },
  });
  assert.equal(signed.ok, true);
  assert.deepEqual(signed.warrant.scope.issueKeys, ['PROJ-1']);
  assert.equal(signed.warrant.grant.trimmed, true);
});

test('a human approving a queued change performs it, once', async () => {
  const { jira, store, deps } = harness();
  await service.performChange({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.TRANSITION, issueKey: 'PROJ-1', value: 'Done' },
  });
  const [queued] = await store.listPending();

  const approved = await service.resolvePending({
    store,
    deps,
    context: HUMAN,
    input: { pendingId: queued.id, decision: 'approve' },
  });
  assert.equal(approved.ok, true);
  assert.equal(jira.writes.length, 1);
  assert.equal(jira.writes[0].kind, 'transition');

  const again = await service.resolvePending({
    store,
    deps,
    context: HUMAN,
    input: { pendingId: queued.id, decision: 'approve' },
  });
  assert.equal(again.ok, false);
  assert.equal(jira.writes.length, 1);
});

test('a human denying a queued change changes nothing', async () => {
  const { jira, store, deps } = harness();
  await service.performChange({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.TRANSITION, issueKey: 'PROJ-1', value: 'Done' },
  });
  const [queued] = await store.listPending();
  const denied = await service.resolvePending({
    store,
    deps,
    context: HUMAN,
    input: { pendingId: queued.id, decision: 'deny' },
  });
  assert.equal(denied.ok, true);
  assert.equal(jira.writes.length, 0);
  assert.equal((await store.listPending()).length, 0);
});

test('a retried refusal does not fill the queue with duplicates', async () => {
  const { store, deps } = harness();
  for (let i = 0; i < 3; i += 1) {
    await service.performChange({
      store,
      deps,
      context: AGENT,
      payload: { operation: OPERATIONS.TRANSITION, issueKey: 'PROJ-1', value: 'Done' },
    });
  }
  assert.equal((await store.listPending()).length, 1);
});

test('revoking stops the next write immediately', async () => {
  const { jira, store, deps } = harness();
  await service.requestWarrant({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.COMMENT, issueKeys: ['PROJ-1'], reason: 'note' },
  });
  const request = await latestRequest(store);
  await service.grantWarrant({ store, context: HUMAN, input: { warrantId: request.id } });

  const revoked = await service.revokeWarrant({
    store,
    context: HUMAN,
    input: { warrantId: request.id, reason: 'wrong project' },
  });
  assert.equal(revoked.warrant.phase, PHASE.REVOKED);

  const answer = await service.performChange({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.COMMENT, issueKey: 'PROJ-1', value: 'still there?' },
  });
  assert.match(answer, /revoked/i);
  assert.equal(jira.writes.length, 0);
});

test('check-warrant answers without changing anything', async () => {
  const { jira, store, deps } = harness();
  const no = await service.checkWarrant({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.TRANSITION, issueKey: 'PROJ-1' },
  });
  assert.match(no, /^No\./);

  await service.requestWarrant({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.TRANSITION, issueKeys: ['PROJ-1'], reason: 'close' },
  });
  const request = await latestRequest(store);
  await service.grantWarrant({ store, context: HUMAN, input: { warrantId: request.id } });

  const yes = await service.checkWarrant({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.TRANSITION, issueKey: 'PROJ-1' },
  });
  assert.match(yes, /^Yes\./);
  assert.equal(jira.writes.length, 0);
});

test('an unsigned request is reported as no authority', async () => {
  const { jira, store, deps } = harness();
  await service.requestWarrant({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.TRANSITION, issueKeys: ['PROJ-1'], reason: 'close' },
  });
  const answer = await service.performChange({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.TRANSITION, issueKey: 'PROJ-1', value: 'Done' },
  });
  assert.match(answer, /no human has signed/i);
  assert.equal(jira.writes.length, 0);
});

test('a failed write inside a valid warrant does not consume the budget', async () => {
  const { store, deps } = harness();
  const jira = {
    ...fakeJira(),
    async getTransitions() {
      return [{ id: '11', name: 'Done', toStatusId: '10000', toStatusName: 'Done' }];
    },
    async transition() {
      throw new Error('Jira 500');
    },
  };
  const broken = { ...deps, jira };

  await service.requestWarrant({
    store,
    deps: broken,
    context: AGENT,
    payload: { operation: OPERATIONS.TRANSITION, issueKeys: ['PROJ-1'], reason: 'close' },
  });
  const request = await latestRequest(store);
  await service.grantWarrant({ store, context: HUMAN, input: { warrantId: request.id } });

  const answer = await service.performChange({
    store,
    deps: broken,
    context: AGENT,
    payload: { operation: OPERATIONS.TRANSITION, issueKey: 'PROJ-1', value: 'Done' },
  });
  assert.match(answer, /nothing was changed/);
  assert.equal((await store.getWarrant(request.id)).usage.used, 0);
});

test('the console snapshot counts every phase', async () => {
  const { store, deps } = harness();
  await service.requestWarrant({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.TRANSITION, issueKeys: ['PROJ-1'], reason: 'one' },
  });
  const first = await latestRequest(store);
  await service.grantWarrant({ store, context: HUMAN, input: { warrantId: first.id } });
  await service.requestWarrant({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.COMMENT, issueKeys: ['PROJ-2'], reason: 'two' },
  });

  const snap = await service.snapshot({ store, context: HUMAN, deps });
  assert.equal(snap.ok, true);
  assert.equal(snap.counts.active, 1);
  assert.equal(snap.counts.requested, 1);
  assert.equal(snap.warrants.length, 2);
  assert.ok(snap.events.length >= 3);
  assert.equal(snap.graph, false);
});

test('the issue panel shows warrants that cover the issue, and nothing else', async () => {
  const { store, deps } = harness();
  await service.requestWarrant({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.TRANSITION, issueKeys: ['PROJ-1'], reason: 'close' },
  });
  await service.requestWarrant({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.COMMENT, issueKeys: ['PROJ-2'], reason: 'note' },
  });

  const panel = await service.issueContext({
    store,
    deps,
    context: HUMAN,
    input: { issueKey: 'proj-1' },
  });
  assert.equal(panel.ok, true);
  assert.equal(panel.issue.key, 'PROJ-1');
  assert.equal(panel.warrants.length, 1);
  assert.equal(panel.warrants[0].operation, OPERATIONS.TRANSITION);
  assert.ok(panel.blast);
  assert.equal(panel.transitions.length, 1);
});

test('context lookups degrade to partial instead of blocking a grant', async () => {  const { store } = harness();
  const twg = {
    enabled: () => true,
    enrich: async (issues) => ({ issues, unavailable: 2 }),
  };
  const deps = { jira: fakeJira(), twg };
  const answer = await service.requestWarrant({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.TRANSITION, issueKeys: ['PROJ-1'], reason: 'close' },
  });
  assert.match(answer, /Context is partial/);
  assert.equal((await latestRequest(store)).state, 'requested');
});

test('declining a request is recorded as a decline, not a revocation', async () => {
  const { store, deps } = harness();
  await service.requestWarrant({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.COMMENT, issueKeys: ['PROJ-1'], reason: 'note' },
  });
  const request = await latestRequest(store);

  const declined = await service.declineRequest({
    store,
    context: HUMAN,
    input: { warrantId: request.id },
  });
  assert.equal(declined.ok, true);
  assert.equal(declined.warrant.phase, PHASE.REVOKED);

  const events = await store.listEvents();
  assert.equal(events[0].type, EVENT.DENIED);
  assert.match(events[0].detail, /declined/);

  // A declined request can never be signed afterwards.
  const late = await service.grantWarrant({
    store,
    context: HUMAN,
    input: { warrantId: request.id },
  });
  assert.equal(late.ok, false);
});

test('a signed warrant cannot be declined — it has to be revoked', async () => {
  const { store, deps } = harness();
  await service.requestWarrant({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.COMMENT, issueKeys: ['PROJ-1'], reason: 'note' },
  });
  const request = await latestRequest(store);
  await service.grantWarrant({ store, context: HUMAN, input: { warrantId: request.id } });

  const answer = await service.declineRequest({
    store,
    context: HUMAN,
    input: { warrantId: request.id },
  });
  assert.equal(answer.ok, false);
  assert.match(answer.error, /already signed/);
  assert.equal((await store.getWarrant(request.id)).state, 'granted');
});

test('the console re-reads the blast radius for requests still awaiting a signature', async () => {
  const { jira, store, deps } = harness();
  await service.requestWarrant({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.TRANSITION, issueKeys: ['PROJ-1'], reason: 'close' },
  });
  const request = await latestRequest(store);
  assert.equal(request.blast.against.length, 0);

  // Something happens in the repository after the agent asked.
  jira.issues.get('PROJ-1').unmergedPrs = [
    { id: '8811', title: 'Fix the focus trap', state: 'OPEN' },
  ];

  const snap = await service.snapshot({ store, context: HUMAN, deps });
  const card = snap.warrants.find((w) => w.id === request.id);
  assert.equal(card.phase, PHASE.REQUESTED);
  const codes = card.blast.against.map((s) => s.code);
  assert.ok(codes.includes('unmerged_pr'), 'the fresh pull request should appear on the card');
  assert.match(card.blast.headline, /code mid-flight/, card.blast.headline);
});

test('a signed warrant keeps the briefing it was signed against', async () => {
  const { jira, store, deps } = harness();
  await service.requestWarrant({
    store,
    deps,
    context: AGENT,
    payload: { operation: OPERATIONS.TRANSITION, issueKeys: ['PROJ-1'], reason: 'close' },
  });
  const request = await latestRequest(store);
  await service.grantWarrant({ store, context: HUMAN, input: { warrantId: request.id } });

  jira.issues.get('PROJ-1').unmergedPrs = [{ id: '8811', title: 'late', state: 'OPEN' }];

  const snap = await service.snapshot({ store, context: HUMAN, deps });
  const card = snap.warrants.find((w) => w.id === request.id);
  // Signed warrants are not re-read: the card keeps showing the briefing the
  // human actually signed against, and its capture time proves it.
  assert.equal(card.blast.computedAt, request.blast.computedAt);
  assert.equal(card.blast.against.length, 0);
});
