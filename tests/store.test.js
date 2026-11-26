import test from 'node:test';
import assert from 'node:assert/strict';

import { CAPS, createStore, memoryDriver } from '../src/store/store.js';
import { OPERATIONS, PHASE, STATE, consume, createRequest, grant, revoke } from '../src/domain/warrant.js';
import { EVENT, createEvent } from '../src/domain/ledger.js';

const NOW = Date.parse('2026-11-20T10:00:00Z');
const HOUR = 3_600_000;

function request(overrides = {}) {
  return createRequest({
    id: 'w-1',
    agent: { kind: 'agent', id: 'rovo', name: 'Steward' },
    operation: OPERATIONS.TRANSITION,
    issueKeys: ['PROJ-1', 'PROJ-2'],
    reason: 'close stale work',
    now: NOW,
    ...overrides,
  });
}

function signed(overrides = {}) {
  return grant(request(), { by: 'acct-1', byName: 'Manass', now: NOW, ...overrides }).warrant;
}

function freshStore(now = NOW) {
  return createStore(memoryDriver(), { now: () => now, newId: (p) => `${p}-fixed` });
}

test('a warrant survives a round trip through the store', async () => {
  const store = freshStore();
  await store.putWarrant(signed());
  const back = await store.getWarrant('w-1');
  assert.equal(back.state, STATE.GRANTED);
  assert.deepEqual(back.scope.issueKeys, ['PROJ-1', 'PROJ-2']);
  assert.equal(await store.getWarrant('nope'), null);
});

test('the store refuses to hand out live references', async () => {
  const store = freshStore();
  await store.putWarrant(signed());
  const first = await store.getWarrant('w-1');
  first.state = STATE.REVOKED;
  const second = await store.getWarrant('w-1');
  assert.equal(second.state, STATE.GRANTED);
});

test('listing attaches the derived phase and sorts newest first', async () => {
  const store = freshStore();
  await store.putWarrant(signed());
  await store.putWarrant(
    createRequest({ id: 'w-2', agent: { id: 'rovo', name: 'S' }, operation: OPERATIONS.COMMENT, issueKeys: ['PROJ-3'], now: NOW + HOUR }),
  );
  const list = await store.listWarrants();
  assert.deepEqual(list.map((w) => w.id), ['w-2', 'w-1']);
  assert.equal(list[1].phase, PHASE.ACTIVE);
  assert.equal(list[0].phase, PHASE.REQUESTED);
});

test('phase filters pick out what the console shows on each tab', async () => {
  const store = freshStore();
  await store.putWarrant(signed());
  await store.putWarrant(createRequest({ id: 'w-2', agent: { id: 'rovo' }, operation: OPERATIONS.COMMENT, issueKeys: ['PROJ-3'], now: NOW }));
  await store.putWarrant(revoke(signed(), { by: 'acct-1', byName: 'Manass', now: NOW }).warrant);
  const requested = await store.listWarrants({ phase: PHASE.REQUESTED });
  assert.deepEqual(requested.map((w) => w.id), ['w-2']);
  const active = await store.listWarrants({ phase: PHASE.ACTIVE });
  assert.equal(active.length, 0);
});

test('an in-scope write is authorised', async () => {
  const store = freshStore();
  await store.putWarrant(signed());
  const result = await store.authorise({ operation: OPERATIONS.TRANSITION, issueKey: 'proj-2' });
  assert.equal(result.ok, true);
  assert.equal(result.warrant.id, 'w-1');
  assert.equal(result.verdict.remaining, 25);
});

test('an out-of-scope write is refused and the near miss is named', async () => {
  const store = freshStore();
  await store.putWarrant(signed());
  const result = await store.authorise({ operation: OPERATIONS.TRANSITION, issueKey: 'PROJ-99' });
  assert.equal(result.ok, false);
  assert.equal(result.verdict.code, 'OUT_OF_SCOPE');
  // It still points at the warrant that nearly covered this, so the refusal
  // can say "extend the warrant you already have".
  assert.equal(result.warrant.id, 'w-1');
});

test('an expired warrant stops authorising without anything having run', async () => {
  let clock = NOW;
  const store = createStore(memoryDriver(), { now: () => clock });
  await store.putWarrant(signed({ ttlMinutes: 30 }));
  assert.equal((await store.authorise({ operation: OPERATIONS.TRANSITION, issueKey: 'PROJ-1' })).ok, true);
  clock = NOW + 31 * 60_000;
  const late = await store.authorise({ operation: OPERATIONS.TRANSITION, issueKey: 'PROJ-1' });
  assert.equal(late.ok, false);
  assert.equal(late.verdict.code, 'EXPIRED');
});

test('with no warrants at all the refusal is NO_WARRANT', async () => {
  const store = freshStore();
  const result = await store.authorise({ operation: OPERATIONS.COMMENT, issueKey: 'PROJ-1' });
  assert.equal(result.ok, false);
  assert.equal(result.verdict.code, 'NO_WARRANT');
});

test('a spent warrant refuses on the next attempt', async () => {
  const store = freshStore();
  let w = signed({ maxActions: 1, issueKeys: ['PROJ-1'] });
  w = consume(w, NOW);
  await store.putWarrant(w);
  const result = await store.authorise({ operation: OPERATIONS.TRANSITION, issueKey: 'PROJ-1' });
  assert.equal(result.verdict.code, 'EXHAUSTED');
});

test('events land in both the per-warrant stream and the site stream', async () => {
  const store = freshStore();
  await store.appendEvent(createEvent({ id: 'e1', type: EVENT.EXECUTED, now: NOW, warrantId: 'w-1', issueKey: 'PROJ-1' }));
  await store.appendEvent(createEvent({ id: 'e2', type: EVENT.BLOCKED, now: NOW + HOUR, warrantId: 'w-2', issueKey: 'PROJ-9' }));
  assert.deepEqual((await store.listEvents({ warrantId: 'w-1' })).map((e) => e.id), ['e1']);
  assert.deepEqual((await store.listEvents()).map((e) => e.id), ['e2', 'e1']);
});

test('undoing marks the event on every stream it lives in', async () => {
  const store = freshStore();
  await store.appendEvent(createEvent({ id: 'e1', type: EVENT.EXECUTED, now: NOW, warrantId: 'w-1' }));
  await store.markUndone('e1', 'w-1');
  assert.equal((await store.listEvents({ warrantId: 'w-1' }))[0].undone, true);
  assert.equal((await store.listEvents())[0].undone, true);
});

test('a refused write can wait for a human and then be resolved', async () => {
  const store = freshStore();
  const queued = await store.queuePending({
    warrantId: 'w-1',
    operation: OPERATIONS.TRANSITION,
    issueKey: 'PROJ-99',
    value: 'Done',
    code: 'OUT_OF_SCOPE',
    actor: { kind: 'agent', id: 'rovo', name: 'Steward' },
  });
  assert.equal(queued.status, 'pending');
  const pending = await store.listPending();
  assert.equal(pending.length, 1);

  const resolved = await store.resolvePending(queued.id, { status: 'approved', by: 'acct-1', byName: 'Manass' });
  assert.equal(resolved.status, 'approved');
  assert.equal((await store.listPending({ status: 'pending' })).length, 0);
  assert.equal(await store.resolvePending('missing', { status: 'approved', by: 'x' }), null);
});

test('the index stays bounded when history grows', async () => {
  const store = freshStore();
  for (let i = 0; i < CAPS.warrants + 15; i += 1) {
    await store.putWarrant(createRequest({
      id: `w-${i}`,
      agent: { id: 'rovo' },
      operation: OPERATIONS.TRANSITION,
      issueKeys: ['PROJ-1'],
      now: NOW + i,
    }));
  }
  const list = await store.listWarrants({ limit: 1000 });
  assert.equal(list.length, CAPS.warrants);
});
