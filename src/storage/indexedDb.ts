// IndexedDB key-value store for the repository. On first use it copies the app's existing
// localStorage data across in one transaction (and leaves the localStorage copy untouched as a
// fallback). If IndexedDB can't be opened (some private-browsing modes), it quietly keeps using
// localStorage instead.
import { prefixedEntries, type AsyncKeyValueStore, type KeyValueStore } from './repository';

const DB = 'chess-coach';
const STORE = 'kv';
const MIGRATED = '__migratedFromLocalStorage';

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

async function migrate(db: IDBDatabase, ls: Storage) {
  const done = await req(db.transaction(STORE).objectStore(STORE).get(MIGRATED));
  if (done) return;
  const tx = db.transaction(STORE, 'readwrite');
  const st = tx.objectStore(STORE);
  for (const [k, v] of prefixedEntries(ls)) st.put(v, k);
  st.put(new Date().toISOString(), MIGRATED);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function indexedDbStore(ls: Storage): AsyncKeyValueStore {
  const fallback: KeyValueStore = ls;
  const ready: Promise<IDBDatabase | null> = (async () => {
    try {
      const db = await open();
      await migrate(db, ls);
      // Ask the browser not to evict our data under storage pressure (best effort).
      void navigator.storage?.persist?.().catch(() => undefined);
      return db;
    } catch (e) {
      console.warn('IndexedDB unavailable, using localStorage:', e);
      return null;
    }
  })();
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = (await ready)!;
    const tx = db.transaction(STORE, mode);
    const result = await req(fn(tx.objectStore(STORE)));
    if (mode === 'readwrite')
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    return result;
  };
  return {
    async get(k) {
      if (!(await ready)) return fallback.getItem(k);
      const v = await run('readonly', (s) => s.get(k));
      return typeof v === 'string' ? v : null;
    },
    async set(k, v) {
      if (!(await ready)) return fallback.setItem(k, v);
      await run('readwrite', (s) => s.put(v, k));
    },
    async remove(k) {
      if (!(await ready)) return fallback.removeItem(k);
      await run('readwrite', (s) => s.delete(k));
    },
  };
}
