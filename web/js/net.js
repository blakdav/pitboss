// Outbound buffer.
//
// The server is the only place data lives. IndexedDB here is a mailbox, not
// a record: a decision is written to it, posted, and deleted on the server's
// acknowledgement. Nothing is ever read back from it except by the flush
// routine, so a cleared cache loses nothing but an unflushed tunnel's worth
// of hands.

const DB_NAME = 'pitboss-outbox';
const DB_VERSION = 1;
const STORES = { decisions: 'decisions', count_checks: 'count_checks' };

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'k', autoIncrement: true });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

async function put(store, record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(db, store, 'readwrite').add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function all(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = tx(db, store, 'readonly').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function remove(store, keys) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const s = tx(db, store, 'readwrite');
    for (const k of keys) s.delete(k);
    s.transaction.oncomplete = () => resolve();
    s.transaction.onerror = () => reject(s.transaction.error);
  });
}

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const outbox = {
  pending: 0,

  async queueDecision(sessionId, decision) {
    await put(STORES.decisions, { sessionId, payload: decision });
    this.pending += 1;
  },

  async queueCountCheck(sessionId, check) {
    await put(STORES.count_checks, { sessionId, payload: check });
    this.pending += 1;
  },

  /** Post everything buffered. Safe to call often; a failure leaves the
   *  records in place for the next attempt. */
  async flush() {
    let sent = 0;
    for (const [kind, store] of Object.entries(STORES)) {
      const records = await all(store);
      if (!records.length) continue;

      const bySession = new Map();
      for (const r of records) {
        if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []);
        bySession.get(r.sessionId).push(r);
      }

      for (const [sessionId, group] of bySession) {
        const body =
          kind === 'decisions'
            ? { decisions: group.map((r) => r.payload) }
            : { checks: group.map((r) => r.payload) };
        try {
          const res = await fetch(`/api/sessions/${sessionId}/${kind}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            // A 404 means the session is gone; the records can never land.
            if (res.status === 404) await remove(store, group.map((r) => r.k));
            continue;
          }
          await remove(store, group.map((r) => r.k));
          sent += group.length;
        } catch (e) {
          // Offline. Leave it buffered.
        }
      }
    }
    this.pending = Math.max(this.pending - sent, 0);
    const left = (await all(STORES.decisions)).length + (await all(STORES.count_checks)).length;
    this.pending = left;
    return { sent, pending: left };
  },
};

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  }
  return res.json();
}

/** Flush whenever the network or the tab comes back. */
export function installFlushTriggers(onFlush) {
  const go = async () => {
    const r = await outbox.flush();
    if (onFlush) onFlush(r);
  };
  window.addEventListener('online', go);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') go();
  });
  setInterval(go, 20000);
  return go;
}
