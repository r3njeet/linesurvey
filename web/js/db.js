// Tiny IndexedDB wrapper.
//   outbox : surveys waiting to be uploaded (record + photo blobs) — works offline
//   local  : surveys stored on this device in DEMO mode (no server configured)
//   blobs  : photo blobs for demo mode
//   kv     : misc cache (last downloaded survey list for offline viewing)
// Survey stretches (start / end point) are kept in `kv` under the key prefixes `stretchbox:` (waiting to upload)
// and `localst:` (demo mode), so the database layout never changes: no upgrade that an open old tab could block.
const DB_NAME = 'line-survey';
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME);   // no version: works with whatever layout already exists
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of ['outbox', 'local']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      for (const s of ['blobs', 'kv']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => { const db = req.result; db.onversionchange = () => { db.close(); dbp = null; }; res(db); };
    req.onerror = () => rej(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Transaction aborted'));
  });
}

const range = (name) => IDBKeyRange.bound(name + ':', name + ':\uffff');
export const idb = {
  /** A small keyed collection inside the `kv` store. */
  coll: (name) => ({
    put: (id, v) => tx('kv', 'readwrite', s => s.put(v, `${name}:${id}`)),
    get: (id) => tx('kv', 'readonly', s => s.get(`${name}:${id}`)),
    del: (id) => tx('kv', 'readwrite', s => s.delete(`${name}:${id}`)),
    all: () => tx('kv', 'readonly', s => s.getAll(range(name))),
    count: () => tx('kv', 'readonly', s => s.count(range(name))),
  }),
  put: (store, value, key) => tx(store, 'readwrite', s => (key === undefined ? s.put(value) : s.put(value, key))),
  get: (store, key) => tx(store, 'readonly', s => s.get(key)),
  del: (store, key) => tx(store, 'readwrite', s => s.delete(key)),
  all: (store) => tx(store, 'readonly', s => s.getAll()),
  count: (store) => tx(store, 'readonly', s => s.count()),
};
