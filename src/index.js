/**
 * The two entry points the manifest points at.
 *
 * `resolver` answers the Custom UI over the Forge bridge. Each Rovo/MCP action
 * has a small named handler below. Both surfaces funnel into the same service
 * functions, so there is one code path for authority and not two.
 */

import { makeResolver } from '@forge/resolver';
import { createStore } from './store/store.js';
import { forgeDriver } from './store/forge-driver.js';
import * as warrants from './service/warrants.js';

const store = createStore(forgeDriver);

/**
 * Forge's bridge sends the invoked name as `call.functionKey`; `Resolver`
 * performs that dispatch and gives each callback the actual payload. Keeping
 * this as a factory also lets the boundary itself be tested without Jira I/O.
 */
export function createUiResolver({ targetStore = store, service = warrants } = {}) {
  const definitions = {};

  const define = (name, callback) => {
    definitions[name] = async ({ payload = {}, context = {} }) => {
      try {
        return await callback({ payload, context });
      } catch (error) {
        // The iframe gets a readable sentence, not a stack trace.
        return { ok: false, error: error.message || 'something went wrong' };
      }
    };
  };

  define('snapshot', ({ context }) => service.snapshot({ store: targetStore, context }));
  define('grant', ({ payload, context }) =>
    service.grantWarrant({ store: targetStore, context, input: payload }),
  );
  define('revoke', ({ payload, context }) =>
    service.revokeWarrant({ store: targetStore, context, input: payload }),
  );
  define('decline', ({ payload, context }) =>
    service.declineRequest({ store: targetStore, context, input: payload }),
  );
  define('resolvePending', ({ payload, context }) =>
    service.resolvePending({ store: targetStore, context, input: payload }),
  );
  define('undo', ({ payload, context }) =>
    service.undo({ store: targetStore, context, input: payload }),
  );
  define('issueContext', ({ payload, context }) =>
    service.issueContext({ store: targetStore, context, input: payload }),
  );
  define('requestForIssue', ({ payload, context }) =>
    service.requestForIssue({ store: targetStore, context, input: payload }),
  );

  return makeResolver(definitions);
}

export const resolver = createUiResolver();

/** Raw Forge functions expose the verified caller under `principal.accountId`. */
function actionContext(context = {}) {
  const accountId = context.accountId || context.principal?.accountId;
  return accountId ? { ...context, accountId: String(accountId) } : context;
}

export function createActionHandler(method, { targetStore = store, service = warrants } = {}) {
  return async (payload = {}, context = {}) => {
    try {
      return await service[method]({
        store: targetStore,
        payload,
        context: actionContext(context),
      });
    } catch (error) {
      return `That failed without changing anything: ${error.message}`;
    }
  };
}

// Action handlers are deliberately separate. The documented action payload
// contains the declared inputs, not an `__actionKey` discriminator.
export const requestWarrant = createActionHandler('requestWarrant');
export const checkWarrant = createActionHandler('checkWarrant');
export const performChange = createActionHandler('performChange');
export const listWarrants = createActionHandler('listWarrants');

export const __internal = { store };
