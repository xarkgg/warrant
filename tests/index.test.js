import test from 'node:test';
import assert from 'node:assert/strict';

import { createActionHandler, createUiResolver } from '../src/index.js';

const UI_ROUTES = [
  ['snapshot', 'snapshot'],
  ['grant', 'grantWarrant'],
  ['revoke', 'revokeWarrant'],
  ['decline', 'declineRequest'],
  ['resolvePending', 'resolvePending'],
  ['undo', 'undo'],
  ['issueContext', 'issueContext'],
  ['requestForIssue', 'requestForIssue'],
];

test('the Custom UI resolver dispatches call.functionKey and passes the bridge payload', async () => {
  const targetStore = { kind: 'test-store' };
  const calls = [];
  const service = Object.fromEntries(
    UI_ROUTES.map(([, method]) => [
      method,
      async (args) => {
        calls.push({ method, args });
        return { ok: true, method };
      },
    ]),
  );
  const resolver = createUiResolver({ targetStore, service });

  for (const [functionKey, method] of UI_ROUTES) {
    const payload = { marker: functionKey };
    const result = await resolver(
      {
        call: { functionKey, payload },
        context: { cloudId: 'cloud-1' },
      },
      {
        installContext: 'ari:cloud:jira::site/cloud-1',
        principal: { accountId: 'acct-human' },
      },
    );

    assert.deepEqual(result, { ok: true, method });
  }

  assert.equal(calls.length, UI_ROUTES.length);
  for (let index = 0; index < calls.length; index += 1) {
    const [functionKey, method] = UI_ROUTES[index];
    const call = calls[index];
    assert.equal(call.method, method);
    assert.equal(call.args.store, targetStore);
    assert.equal(call.args.context.accountId, 'acct-human');
    assert.equal(call.args.context.cloudId, 'cloud-1');
    if (functionKey === 'snapshot') assert.equal(call.args.input, undefined);
    else assert.deepEqual(call.args.input, { marker: functionKey });
  }
});

test('the Custom UI resolver turns backend exceptions into readable results', async () => {
  const resolver = createUiResolver({
    targetStore: {},
    service: {
      ...Object.fromEntries(UI_ROUTES.map(([, method]) => [method, async () => ({ ok: true })])),
      issueContext: async () => {
        throw new Error('Jira could not read that issue');
      },
    },
  });

  const result = await resolver(
    {
      call: { functionKey: 'issueContext', payload: { issueKey: 'TEST-1' } },
      context: {},
    },
    {},
  );

  assert.deepEqual(result, { ok: false, error: 'Jira could not read that issue' });
});

test('a named Rovo action does not depend on an action key in its payload', async () => {
  const targetStore = { kind: 'test-store' };
  let received;
  const handler = createActionHandler('performChange', {
    targetStore,
    service: {
      async performChange(args) {
        received = args;
        return 'Done from the named handler.';
      },
    },
  });
  const payload = { operation: 'jira.comment', issueKey: 'TEST-1', value: 'Ready' };

  const result = await handler(payload, {
    installContext: 'ari:cloud:jira::site/cloud-1',
    principal: { accountId: 'acct-human' },
  });

  assert.equal(result, 'Done from the named handler.');
  assert.equal(received.store, targetStore);
  assert.equal(received.payload, payload);
  assert.equal(received.context.accountId, 'acct-human');
});
