/**
 * Persistence.
 *
 * Forge Storage is a key-value store with no transactions, so everything here
 * is written to be idempotent and to fail towards *refusing authority* rather
 * than granting it. The driver interface is three methods, which is what makes
 * the whole layer testable in memory on a phone (tests/store.test.js).
 *
 * Layout:
 *   warrant:<id>      the warrant document
 *   warrants:index    ids, newest first, capped
 *   ledger:<id>       events for one warrant, capped
 *   ledger:all        recent events across the site, capped
 *   pending:<id>      a refused write waiting for a human
 *   pending:index     ids, oldest first, capped
 *
 * The caps exist because a key-value store is not a database. They are also a
 * feature: an unbounded audit log inside an app is a liability nobody reads.
 */

import { PHASE, evaluate, phaseOf } from '../domain/warrant.js';
import { sortEvents } from '../domain/ledger.js';

export const CAPS = Object.freeze({
  warrants: 400,
  ledgerPerWarrant: 200,
  ledgerAll: 600,
  pending: 200,
});

const K = {
  warrant: (id) => `warrant:${id}`,
  warrantsIndex: 'warrants:index',
  ledger: (id) => `ledger:${id}`,
  ledgerAll: 'ledger:all',
  pending: (id) => `pending:${id}`,
  pendingIndex: 'pending:index',
};

export function createStore(driver, { now = Date.now, newId = defaultId } = {}) {
  const read = async (key, fallback) => {
    const value = await driver.get(key);
    return value === undefined || value === null ? fallback : value;
  };

  async function pushCapped(key, value, cap) {
    const list = await read(key, []);
    const next = [value, ...list.filter((v) => v !== value)].slice(0, cap);
    await driver.set(key, next);
    return next;
  }

  async function removeFrom(key, value) {
    const list = await read(key, []);
    const next = list.filter((v) => v !== value);
    await driver.set(key, next);
    return next;
  }

  return {
    // -- warrants ----------------------------------------------------------

    async putWarrant(warrant) {
      await driver.set(K.warrant(warrant.id), warrant);
      await pushCapped(K.warrantsIndex, warrant.id, CAPS.warrants);
      return warrant;
    },

    async getWarrant(id) {
      return read(K.warrant(id), null);
    },

    async listWarrants({ phase = null, agentId = null, limit = 100 } = {}) {
      const ids = await read(K.warrantsIndex, []);
      const docs = await Promise.all(ids.map((id) => driver.get(K.warrant(id))));
      const at = now();
      const out = docs
        .filter(Boolean)
        .map((w) => ({ ...w, phase: phaseOf(w, at) }))
        .filter((w) => (phase ? w.phase === phase : true))
        .filter((w) => (agentId ? w.agent?.id === agentId : true))
        .sort(byRecency);
      return out.slice(0, limit);
    },

    /**
     * Find warrants that could authorise this write, then let the policy core
     * decide. Candidates are cheap; `evaluate` is the only thing that can say
     * yes.
     */
    async findFor({ operation, issueKey, agentId = null }) {
      const all = await this.listWarrants({ limit: CAPS.warrants });
      const key = String(issueKey || '').toUpperCase();
      return all
        .filter((w) => w.request?.operation === operation)
        .filter((w) => (agentId ? w.agent?.id === agentId : true))
        .filter((w) => (w.scope?.issueKeys || []).includes(key))
        .filter((w) => w.phase === PHASE.ACTIVE)
        .sort((a, b) => Date.parse(a.limits?.expiresAt || 0) - Date.parse(b.limits?.expiresAt || 0));
    },

    /** The verdict the caller acts on. Never returns a warrant on refusal. */
    async authorise({ operation, issueKey, agentId = null }) {
      const candidates = await this.findFor({ operation, issueKey, agentId });
      const at = now();
      let firstDenial = null;
      for (const candidate of candidates) {
        const verdict = evaluate(candidate, { operation, issueKey, now: at });
        if (verdict.ok) return { ok: true, warrant: candidate, verdict };
        firstDenial = firstDenial || verdict;
      }
      if (firstDenial) return { ok: false, verdict: firstDenial, warrant: null };

      // Nothing matched on scope or phase, so look for the closest warrant to
      // explain *why* — a good refusal names the thing that nearly worked.
      const all = await this.listWarrants({ limit: CAPS.warrants });
      const sameOp = all.filter((w) => w.request?.operation === operation);
      if (sameOp.length === 0) {
        return {
          ok: false,
          warrant: null,
          verdict: evaluate(null, { operation, issueKey, now: at }),
        };
      }
      const best = sameOp.find((w) => w.phase === PHASE.ACTIVE) || sameOp[0];
      return {
        ok: false,
        warrant: best,
        verdict: evaluate(best, { operation, issueKey, now: at }),
      };
    },

    // -- ledger ------------------------------------------------------------

    async appendEvent(event) {
      await driver.set(K.ledger(event.warrantId || 'none'), await capped(K.ledger(event.warrantId || 'none'), event, CAPS.ledgerPerWarrant));
      await driver.set(K.ledgerAll, await capped(K.ledgerAll, event, CAPS.ledgerAll));
      return event;
    },

    async listEvents({ warrantId = null, limit = 100 } = {}) {
      const key = warrantId ? K.ledger(warrantId) : K.ledgerAll;
      const events = await read(key, []);
      return sortEvents(events).slice(0, limit);
    },

    async markUndone(eventId, warrantId) {
      for (const key of [K.ledger(warrantId || 'none'), K.ledgerAll]) {
        const events = await read(key, []);
        const next = events.map((e) => (e.id === eventId ? { ...e, undone: true } : e));
        await driver.set(key, next);
      }
    },

    // -- pending approvals -------------------------------------------------

    async queuePending(attempt) {
      const record = {
        id: attempt.id || newId('p'),
        at: new Date(now()).toISOString(),
        status: 'pending',
        ...attempt,
      };
      await driver.set(K.pending(record.id), record);
      await pushCapped(K.pendingIndex, record.id, CAPS.pending);
      return record;
    },

    async listPending({ status = 'pending', limit = 50 } = {}) {
      const ids = await read(K.pendingIndex, []);
      const docs = await Promise.all(ids.map((id) => driver.get(K.pending(id))));
      return docs
        .filter(Boolean)
        .filter((p) => (status ? p.status === status : true))
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
        .slice(0, limit);
    },

    async getPending(id) {
      return read(K.pending(id), null);
    },

    async resolvePending(id, { status, by, byName, now: at = now() }) {
      const record = await read(K.pending(id), null);
      if (!record) return null;
      const next = {
        ...record,
        status,
        resolvedAt: new Date(at).toISOString(),
        resolvedBy: { id: String(by || ''), name: String(byName || '') },
      };
      await driver.set(K.pending(id), next);
      return next;
    },

    async dropPending(id) {
      await driver.set(K.pending(id), null);
      await removeFrom(K.pendingIndex, id);
    },
  };

  async function capped(key, event, cap) {
    const list = await read(key, []);
    const next = [event, ...list.filter((e) => e.id !== event.id)];
    return next.slice(0, cap);
  }
}

/** Plain in-memory driver. Used by tests and by the UI preview harness. */
export function memoryDriver(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : null;
    },
    async set(key, value) {
      if (value === null || value === undefined) map.delete(key);
      else map.set(key, structuredClone(value));
      return true;
    },
    async delete(key) {
      map.delete(key);
      return true;
    },
    size: () => map.size,
  };
}

function byRecency(a, b) {
  const at = Date.parse(a.request?.requestedAt || 0);
  const bt = Date.parse(b.request?.requestedAt || 0);
  if (at !== bt) return bt - at;
  return String(b.id).localeCompare(String(a.id));
}

let counter = 0;
export function defaultId(prefix = 'w') {
  counter = (counter + 1) % 1e6;
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${time}${counter.toString(36)}${rand}`;
}
