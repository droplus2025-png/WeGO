/* wego_store.js — two interchangeable storage adapters with the same API:
     store.tx(storeNames, 'readonly' | 'readwrite', async (tx) => { ... })
   Inside the callback, tx offers: get, put, del, all, byIndex.
   The whole callback is one atomic unit: if it throws, nothing is written.
   Inside the callback, only await tx calls (never fetch/timers), so the
   IndexedDB transaction stays alive. */
(function (root) {
  'use strict';

  const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

  function indexValue(rec, keyPath) {
    return Array.isArray(keyPath) ? keyPath.map((k) => rec[k]) : rec[keyPath];
  }
  function validKey(v) {
    if (Array.isArray(v)) return v.every((x) => x !== undefined && x !== null);
    return v !== undefined && v !== null;
  }
  function sameKey(a, b) {
    return Array.isArray(a) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b;
  }

  /* ---------- In-memory adapter (tests, and a fallback) ---------- */
  class MemoryStore {
    constructor(schema) {
      this.schema = schema;
      this.maps = {};
      for (const name of Object.keys(schema.stores)) this.maps[name] = new Map();
      this._queue = Promise.resolve();
    }

    async open() { return this; }

    // Transactions run one after another, like IndexedDB readwrite transactions on the same stores.
    tx(names, mode, fn) {
      const run = async () => {
        const backup = {};
        if (mode === 'readwrite') {
          for (const n of names) backup[n] = new Map([...this.maps[n]].map(([k, v]) => [k, clone(v)]));
        }
        try {
          return await fn(this._ctx(names, mode));
        } catch (e) {
          for (const n of Object.keys(backup)) this.maps[n] = backup[n];
          throw e;
        }
      };
      const p = this._queue.then(run);
      this._queue = p.catch(() => {});
      return p;
    }

    _ctx(names, mode) {
      const map = (s) => {
        if (!names.includes(s)) throw new Error('Store not part of this transaction: ' + s);
        return this.maps[s];
      };
      const writable = () => { if (mode !== 'readwrite') throw new Error('Transaction is read-only'); };
      const def = (s) => this.schema.stores[s];
      return {
        get: async (s, key) => { const v = map(s).get(key); return v === undefined ? undefined : clone(v); },
        put: async (s, rec) => {
          writable();
          const key = rec[def(s).keyPath];
          if (key === undefined || key === null) throw new Error('Missing key on ' + s);
          map(s).set(key, clone(rec));
          return key;
        },
        del: async (s, key) => { writable(); map(s).delete(key); },
        all: async (s) => [...map(s).values()].map(clone),
        byIndex: async (s, index, value) => {
          const kp = def(s).indexes[index];
          if (kp === undefined) throw new Error('Unknown index ' + s + '.' + index);
          return [...map(s).values()]
            .filter((r) => { const iv = indexValue(r, kp); return validKey(iv) && sameKey(iv, value); })
            .map(clone);
        },
      };
    }
  }

  /* ---------- IndexedDB adapter (browser) ---------- */
  class IdbStore {
    constructor(schema, name, idb) {
      this.schema = schema;
      this.name = name || 'wego_db';
      this.idb = idb || globalThis.indexedDB;
      this.db = null;
    }

    open() {
      return new Promise((resolve, reject) => {
        const req = this.idb.open(this.name, this.schema.version);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const [name, def] of Object.entries(this.schema.stores)) {
            const os = db.objectStoreNames.contains(name)
              ? req.transaction.objectStore(name)
              : db.createObjectStore(name, { keyPath: def.keyPath });
            for (const [idx, kp] of Object.entries(def.indexes || {})) {
              if (!os.indexNames.contains(idx)) os.createIndex(idx, kp, { unique: false });
            }
          }
        };
        req.onsuccess = () => { this.db = req.result; resolve(this); };
        req.onerror = () => reject(req.error);
      });
    }

    tx(names, mode, fn) {
      return new Promise((resolve, reject) => {
        const t = this.db.transaction(names, mode);
        const rq = (r) => new Promise((ok, ko) => { r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); });
        const ctx = {
          get: (s, key) => rq(t.objectStore(s).get(key)),
          put: (s, rec) => rq(t.objectStore(s).put(rec)),
          del: (s, key) => rq(t.objectStore(s).delete(key)),
          all: (s) => rq(t.objectStore(s).getAll()),
          byIndex: (s, index, value) => rq(t.objectStore(s).index(index).getAll(value)),
        };
        let result;
        let failure = null;
        t.oncomplete = () => resolve(result);
        t.onabort = () => reject(failure || t.error || new Error('Transaction aborted'));
        Promise.resolve()
          .then(() => fn(ctx))
          .then((r) => { result = r; })
          .catch((e) => { failure = e; try { t.abort(); } catch (_) { /* already finished */ } });
      });
    }
  }

  const api = { MemoryStore, IdbStore };
  root.WeGo = root.WeGo || {};
  root.WeGo.store = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
