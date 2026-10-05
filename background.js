// Service worker: scheduling, on-demand runs, crash-safe resume and reports.
import {
  loadConfig, saveConfig, getState, saveState, appendRun, getRuns, loadAttachmentBytes, loadInlineImages, resetState,
  getActiveRun, setActiveRun,
} from './lib/store.js';
import { getToken, connect, disconnect } from './lib/auth.js';
import { Gmail } from './lib/gmail.js';
import { runEngine } from './lib/engine.js';
import { reportEmail } from './lib/report.js';

const ALARM = 'email-manager-run';
const WATCHDOG = 'email-manager-watchdog';
const STALE_MS = 3 * 60 * 1000;     // no progress for 3 min → treat the run as stalled
const MAX_RESUMES = 6;

// ---------------------------------------------------------------- scheduling
function nextDailyTime(hhmm, weekdaysOnly) {
  const [h, m] = (hhmm || '08:00').split(':').map(Number);
  const d = new Date();
  d.setSeconds(0, 0);
  d.setHours(h, m);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  while (weekdaysOnly && (d.getDay() === 0 || d.getDay() === 6)) d.setDate(d.getDate() + 1);
  return d.getTime();
}

async function applySchedule() {
  const config = await loadConfig();
  await chrome.alarms.clear(ALARM);
  if (!config.configured) return;
  const s = config.schedule;
  if (s.mode === 'interval') {
    const every = Math.max(15, Number(s.everyMinutes) || 60);
    await chrome.alarms.create(ALARM, { delayInMinutes: every, periodInMinutes: every });
  } else if (s.mode === 'daily') {
    await chrome.alarms.create(ALARM, { when: nextDailyTime(s.dailyTime, s.weekdaysOnly) });
  }
}

chrome.runtime.onInstalled.addListener(async () => { await applySchedule(); await resumeIfInterrupted('install'); });
chrome.runtime.onStartup.addListener(async () => { await applySchedule(); await resumeIfInterrupted('startup'); });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === WATCHDOG) return resumeIfInterrupted('watchdog');
  if (alarm.name !== ALARM) return;
  const config = await loadConfig();
  if (config.schedule.mode === 'daily') await applySchedule();   // book the next day
  const d = new Date().getDay();
  if (config.schedule.mode === 'daily' && config.schedule.weekdaysOnly && (d === 0 || d === 6)) return;
  await startRun({ dryRun: false, trigger: 'schedule' });
});

// ---------------------------------------------------------------- status
async function setStatus(patch) {
  const { status = {} } = await chrome.storage.local.get('status');
  await chrome.storage.local.set({ status: { ...status, ...patch, updatedAt: Date.now() } });
}

async function setBadge(text, color = '#1a73e8') {
  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
  } catch { /* ignore */ }
}

function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message });
}

// ---------------------------------------------------------------- running
let running = null;   // in-memory promise; lost if the service worker is restarted
let stopRequested = false;

async function startRun({ dryRun, trigger, resumeFrom = null }) {
  if (running) return { ok: false, error: 'A run is already in progress.' };
  const active = await getActiveRun();
  if (active && !resumeFrom) {
    // A run was interrupted; continue it rather than starting over.
    resumeFrom = active;
    dryRun = active.dryRun;
    trigger = active.trigger;
  }
  stopRequested = false;
  running = doRun({ dryRun, trigger, resumeFrom }).finally(() => { running = null; });
  return { ok: true, resumed: !!resumeFrom };
}

/** Called on browser start, extension reload and every minute while a run is active. */
async function resumeIfInterrupted(source) {
  const active = await getActiveRun();
  if (!active) { await chrome.alarms.clear(WATCHDOG); return; }
  if (running) {
    // Still running in this worker. Requests time out on their own (lib/gmail.js),
    // so a stale heartbeat here only means a very slow step; just report it.
    if (Date.now() - (active.heartbeat || 0) > STALE_MS) await setStatus({ progress: 'Waiting for Gmail to respond…' });
    return;
  }
  if ((active.resumes || 0) >= MAX_RESUMES) {
    active.error = `Stopped after ${MAX_RESUMES} automatic restarts. Click "Run now" to try again.`;
    await finishRun(active, await loadConfig(), active.error);
    return;
  }
  await setStatus({ progress: `Resuming the interrupted run (${source})…` });
  await startRun({ dryRun: active.dryRun, trigger: active.trigger, resumeFrom: active });
}

async function signatureFor(gmail, email) {
  try {
    const { sendAs = [] } = (await gmail.listSendAs()) || {};
    const me = sendAs.find((s) => s.sendAsEmail.toLowerCase() === email.toLowerCase()) || sendAs.find((s) => s.isPrimary);
    return me?.signature || '';
  } catch {
    return '';
  }
}

function gmailFor(email) {
  return new Gmail(({ force } = {}) => getToken(email, { force }));
}

async function doRun({ dryRun, trigger, resumeFrom }) {
  const config = await loadConfig();
  if (!config.configured) {
    await setStatus({ running: false, lastError: 'Finish setup first.' });
    return;
  }
  const email = resumeFrom?.account || config.account.email;
  await setStatus({ running: true, dryRun, progress: resumeFrom ? 'Resuming where it stopped…' : 'Starting…', lastError: '' });
  await setBadge('…');
  await chrome.alarms.create(WATCHDOG, { periodInMinutes: 1 });

  const state = await getState(email);
  const gmail = gmailFor(email);
  const seed = resumeFrom || { id: Date.now().toString(36), startedAt: Date.now(), account: email, dryRun, trigger };
  await setActiveRun({ ...seed, trigger, dryRun, heartbeat: Date.now(), counts: seed.counts || {}, items: seed.items || [] });

  let run;
  try {
    run = await runEngine({
      config: { ...config, account: { ...config.account, email } },
      gmail, state, dryRun,
      resumeFrom: resumeFrom?.counts?.evaluated !== undefined ? resumeFrom : null,
      loadAttachments: () => loadAttachmentBytes(config.attachments),
      loadInlineImages,
      getSignature: () => signatureFor(gmail, email),
      onProgress: (progress) => setStatus({ progress }),
      shouldStop: () => stopRequested,
      onCheckpoint: async (r) => {
        if (!dryRun) await saveState(email, state);
        await setActiveRun({ ...r, trigger, dryRun, account: email, heartbeat: Date.now() });
      },
    });
    run.trigger = trigger;
    run.account = email;
    if (!dryRun) await saveState(email, state);
    await finishRun(run, config);
  } catch (e) {
    const msg = e.message || String(e);
    const partial = (await getActiveRun()) || seed;
    partial.error = msg;
    await setStatus({ needsReconnect: !!e.needsReconnect });
    await finishRun(partial, config, msg);
  }
}

async function finishRun(run, config, error = '') {
  run.finishedAt = Date.now();
  run.counts = { evaluated: 0, replied: 0, labeled: 0, left: 0, skipped: 0, duplicates: 0, errors: 0, ...(run.counts || {}) };
  run.items = run.items || [];
  if (error) run.error = error;
  delete run.heartbeat;
  await setActiveRun(null);
  await chrome.alarms.clear(WATCHDOG);

  const c = run.counts;
  const summary = run.dryRun
    ? `Preview: would reply to ${c.replied}, label ${c.labeled}, leave ${c.left + c.duplicates}.`
    : `Replied ${c.replied}, labeled ${c.labeled}, left ${c.left + c.duplicates}, skipped ${c.skipped}${c.errors ? `, ${c.errors} error(s)` : ''}.`;

  // E-mail the spreadsheet report to the inbox that was processed.
  const r = config.report;
  const hadActivity = c.replied || c.labeled || c.errors || (error && c.evaluated);
  if (r.emailAfterRun && (!run.dryRun || r.includePreviews) && (!r.onlyWhenActivity || hadActivity)) {
    try {
      await gmailFor(run.account).sendRaw(reportEmail(run));
      run.reportEmailed = true;
    } catch (e) {
      run.reportError = 'Report e-mail could not be sent: ' + (e.message || e);
    }
  }
  await appendRun(run);

  await setStatus({
    running: false, progress: '', lastRunAt: Date.now(), lastRunId: run.id,
    lastSummary: error ? '' : summary + (run.stoppedReason ? ` ${run.stoppedReason}.` : ''),
    lastError: error,
  });
  await setBadge(error || c.errors ? '!' : '', error || c.errors ? '#d93025' : '#1a73e8');
  if (config.schedule.notify && run.trigger === 'schedule' && (c.replied || c.errors || error)) {
    notify(error ? 'E-Mail Manager needs attention' : 'E-Mail Manager', error || summary);
  }
}

// ---------------------------------------------------------------- messages from popup / setup page
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'run':
        return startRun({ dryRun: !!msg.dryRun, trigger: msg.dryRun ? 'preview' : 'manual' });
      case 'stop': {
        if (running) { stopRequested = true; return { ok: true }; }
        const active = await getActiveRun();
        if (active) await finishRun(active, await loadConfig(), 'Stopped by you.');
        return { ok: true };
      }
      case 'configSaved':
        await applySchedule();
        return { ok: true };
      case 'nextRun': {
        const a = await chrome.alarms.get(ALARM);
        return { when: a?.scheduledTime || null };
      }
      case 'connect': {
        const email = await connect(msg.email);
        await setStatus({ needsReconnect: false, lastError: '' });
        return { ok: true, email };
      }
      case 'switchInbox': {
        // Make another inbox the target, keeping all other settings.
        const email = await connect(msg.email);
        const config = await loadConfig();
        config.account = { ...config.account, email, connected: true };
        if (config.scope.label !== 'INBOX') { config.scope.label = 'INBOX'; config.scope.labelName = 'Inbox'; }
        await saveConfig(config);
        await setStatus({ needsReconnect: false, lastError: '' });
        return { ok: true, email };
      }
      case 'disconnect':
        await disconnect(msg.email);
        return { ok: true };
      case 'listLabels': {
        const config = await loadConfig();
        const email = msg.email || config.account.email;
        const { labels = [] } = (await gmailFor(email).listLabels()) || {};
        return { ok: true, labels: labels.map((l) => ({ id: l.id, name: l.name, type: l.type })) };
      }
      case 'emailReport': {
        const run = (await getRuns()).find((x) => x.id === msg.runId);
        if (!run) return { ok: false, error: 'That run is no longer in the history.' };
        await gmailFor(run.account).sendRaw(reportEmail(run));
        return { ok: true, to: run.account };
      }
      case 'resetHistory': {
        const config = await loadConfig();
        await resetState(msg.email || config.account.email);
        return { ok: true };
      }
      default:
        return { ok: false, error: 'Unknown message' };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: e.message || String(e) }));
  return true;
});

// Each time the worker wakes, check whether a run was cut off (e.g. Chrome crashed).
resumeIfInterrupted('wake').catch(() => {});
