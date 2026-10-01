// Settings (chrome.storage.local) and attachment files (IndexedDB).
import { defaultConfig } from './defaults.js';

// ---------- settings ----------
function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over)) return over ?? base;
  if (base && typeof base === 'object' && over && typeof over === 'object') {
    const out = { ...base };
    for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
    return out;
  }
  return over === undefined ? base : over;
}

export async function loadConfig() {
  const { config } = await chrome.storage.local.get('config');
  return deepMerge(defaultConfig(), config || {});
}

export async function saveConfig(config) {
  await chrome.storage.local.set({ config });
}

// ---------- run state ----------
// Per-inbox history so switching inboxes never mixes up what was handled.
const stateKey = (email) => 'state:' + String(email || '').toLowerCase();

export async function getState(email) {
  const { [stateKey(email)]: state } = await chrome.storage.local.get(stateKey(email));
  return {
    processed: {},     // threadId -> historyId at time of handling
    failures: {},      // threadId -> count
    repliedKeys: {},   // duplicate key -> timestamp
    sentLog: [],       // timestamps of sends in the last 24h
    ...(state || {}),
  };
}

export async function saveState(email, state) {
  // Trim old entries so storage does not grow without bound.
  const dayAgo = Date.now() - 864e5;
  state.sentLog = (state.sentLog || []).filter((t) => t > dayAgo);
  const keyCutoff = Date.now() - 180 * 864e5;
  for (const [k, t] of Object.entries(state.repliedKeys || {})) if (t < keyCutoff) delete state.repliedKeys[k];
  const ids = Object.keys(state.processed || {});
  if (ids.length > 20000) for (const id of ids.slice(0, ids.length - 20000)) delete state.processed[id];
  await chrome.storage.local.set({ [stateKey(email)]: state });
}

export async function resetState(email) {
  await chrome.storage.local.remove(stateKey(email));
}

// Checkpoint of the run in progress, used to resume after a crash or restart.
export async function getActiveRun() {
  const { activeRun } = await chrome.storage.local.get('activeRun');
  return activeRun || null;
}
export async function setActiveRun(run) {
  if (run) await chrome.storage.local.set({ activeRun: run });
  else await chrome.storage.local.remove('activeRun');
}

export async function appendRun(run) {
  const { runs = [] } = await chrome.storage.local.get('runs');
  runs.unshift(run);
  await chrome.storage.local.set({ runs: runs.slice(0, 30) });
}

export async function getRuns() {
  const { runs = [] } = await chrome.storage.local.get('runs');
  return runs;
}

// ---------- attachment files ----------
const DB = 'email-manager';
const STORE = 'files';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(out?.result ?? out); };
    t.onerror = () => { db.close(); reject(t.error); };
  }));
}

export function putFile(rec) { return tx('readwrite', (s) => s.put(rec)); }
export function deleteFile(id) { return tx('readwrite', (s) => s.delete(id)); }
export function getFile(id) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(id);
    req.onsuccess = () => { db.close(); resolve(req.result || null); };
    req.onerror = () => { db.close(); reject(req.error); };
  }));
}

/** Loads attachment bytes for the configured list. Missing files throw. */
export async function loadAttachmentBytes(list) {
  const out = [];
  for (const a of list || []) {
    const rec = await getFile(a.id);
    if (!rec) throw new Error(`Attachment "${a.name}" is missing. Re-add it in Settings → Attachments.`);
    out.push({ name: rec.name, type: rec.type, bytes: new Uint8Array(await rec.blob.arrayBuffer()) });
  }
  return out;
}
