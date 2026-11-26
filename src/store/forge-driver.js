import forgeApi from '@forge/api';

const { storage } = forgeApi;

/**
 * The Forge Storage driver. Three methods, because that is all the store needs
 * and because it keeps the whole persistence layer swappable in tests.
 *
 * Forge Storage has no transactions and no server-side query in this shape, so
 * read-modify-write on the indexes can lose a concurrent update. That is an
 * acceptable trade for content nobody is racing to write (a human signing a
 * warrant), and it is written down rather than assumed away.
 */
export const forgeDriver = {
  get: (key) => storage.get(key),
  set: (key, value) => storage.set(key, value),
  delete: (key) => storage.delete(key),
};
