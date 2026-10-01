import { loadConfig, getRuns } from './lib/store.js';
import { reportBytes, reportFileName } from './lib/report.js';
import { XLSX_MIME } from './lib/xlsx.js';

const $ = (s) => document.querySelector(s);
const send = (msg) => chrome.runtime.sendMessage(msg);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ICON = { replied: '✅', 'would-reply': '✉️', labeled: '🏷️', left: '⏸️', skipped: '↩️', duplicate: '⧉', deferred: '⏳', error: '⚠️' };

let cfg;
let tabEmail = '';
let lastRun = null;
let target = '';   // inbox the next run acts on: the Gmail tab you clicked from, unless you pick another

/** If the active tab is Gmail, read the account address from its title ("Inbox (3) - me@x.com - Gmail"). */
async function detectGmailAccount() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.startsWith('https://mail.google.com/')) return '';
    const m = (tab.title || '').match(/[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/);
    return m ? m[0].toLowerCase() : '';
  } catch {
    return '';
  }
}

function openSettings(extra = '') {
  chrome.tabs.create({ url: chrome.runtime.getURL('app.html' + extra) });
  window.close();
}

async function switchInbox(email, { ask = true } = {}) {
  if (ask && !confirm(`Switch E-Mail Manager to ${email}?\n\nGoogle may ask you to sign in to that account. Your rules, reply text and attachments stay the same.`)) {
    target = cfg.account.email;
    renderInboxSelect();
    return false;
  }
  setStatusHtml(`<span class="pill">Connecting</span> ${esc(email)}…`);
  const r = await send({ type: 'switchInbox', email });
  if (!r?.ok) {
    setStatusHtml(`<span class="pill bad">Not switched</span> ${esc(r?.error)}`);
    target = cfg.account.email;
    renderInboxSelect();
    return false;
  }
  cfg = await loadConfig();
  target = cfg.account.email;
  renderInboxSelect();
  renderTabNotice();
  await renderStatus();
  return true;
}

function renderInboxSelect() {
  const sel = $('#inboxSel');
  sel.innerHTML = '';
  const configured = cfg.account.email.toLowerCase();
  if (tabEmail) sel.add(new Option(`${tabEmail} (this tab)`, tabEmail));
  if (configured !== tabEmail) sel.add(new Option(`${cfg.account.email} (last used)`, configured));
  sel.add(new Option('Another inbox…', '__other'));
  sel.value = target;
  sel.onchange = async () => {
    let v = sel.value;
    if (v === '__other') {
      v = (prompt('E-mail address of the inbox to work on:') || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { renderInboxSelect(); return; }
    }
    target = v;
    if (v !== configured) await switchInbox(v);
    renderTabNotice();
  };
}

function renderTabNotice() {
  const box = $('#tabNotice');
  if (tabEmail && target === tabEmail && tabEmail !== cfg.account.email.toLowerCase()) {
    box.innerHTML = `Runs will act on <b>${esc(tabEmail)}</b>, the inbox open in this tab. To keep using <b>${esc(cfg.account.email)}</b>, choose it below.`;
    box.classList.remove('hidden');
  } else if (tabEmail) {
    box.innerHTML = `Acting on <b>${esc(target)}</b>${target === tabEmail ? ', the inbox open in this tab' : ''}. You can choose another below.`;
    box.classList.remove('hidden');
  } else {
    box.classList.add('hidden');
  }
}

function setStatusHtml(html) { $('#statusBox').innerHTML = html; }

async function renderStatus() {
  const { status = {} } = await chrome.storage.local.get('status');
  const running = !!status.running;
  $('#runBtn').disabled = running;
  $('#previewBtn').disabled = running;
  $('#stopBtn').classList.toggle('hidden', !running);
  if (running) {
    setStatusHtml(`<span class="pill">${status.dryRun ? 'Previewing' : 'Running'}</span> ${esc(status.progress || '')}`);
  } else if (status.lastError) {
    setStatusHtml(`<span class="pill bad">Needs attention</span> ${esc(status.lastError)}` +
      (status.needsReconnect ? ` <button class="link" id="reconnect">Reconnect</button>` : ''));
    const rc = $('#reconnect');
    if (rc) rc.onclick = async () => {
      const r = await send({ type: 'connect', email: cfg.account.email });
      setStatusHtml(r?.ok ? '<span class="pill ok">Reconnected</span> You can run again.' : `<span class="pill bad">Not connected</span> ${esc(r?.error)}`);
    };
  } else if (status.lastSummary) {
    setStatusHtml(`<span class="pill ok">Last run</span> ${esc(status.lastSummary)} <span class="muted small">${new Date(status.lastRunAt).toLocaleString()}</span>`);
  } else {
    setStatusHtml('Ready. Try <b>Preview</b> first — it shows what would happen without sending anything.');
  }

  const s = cfg.schedule;
  const { when } = (await send({ type: 'nextRun' })) || {};
  $('#schedLine').textContent = s.mode === 'off'
    ? 'Runs only when you click Run now.'
    : `Scheduled ${s.mode === 'daily' ? `daily at ${s.dailyTime}` : `every ${s.everyMinutes >= 60 ? s.everyMinutes / 60 + ' h' : s.everyMinutes + ' min'}`}` +
      (when ? ` · next ${new Date(when).toLocaleString()}` : '') + ` · ${s.batchSize} e-mails per run.`;
  await renderLastRun();
}

async function renderLastRun() {
  const runs = await getRuns();
  lastRun = runs[0] || null;
  const box = $('#lastRun');
  const list = $('#items');
  list.innerHTML = '';
  $('#reportBtns').classList.toggle('hidden', !lastRun);
  if (!lastRun) { box.textContent = 'No runs yet.'; return; }
  const c = lastRun.counts || {};
  box.innerHTML = `${new Date(lastRun.startedAt).toLocaleString()} · ${esc(lastRun.account || '')}${lastRun.dryRun ? ' · <b>preview</b>' : ''}<br>` +
    `Checked ${c.evaluated ?? 0} · ${lastRun.dryRun ? 'would reply' : 'replied'} ${c.replied ?? 0} · labeled ${c.labeled ?? 0} · left ${(c.left ?? 0) + (c.duplicates ?? 0)} · errors ${c.errors ?? 0}` +
    (lastRun.resumes ? `<br>Resumed ${lastRun.resumes}× after an interruption.` : '') +
    (lastRun.reportEmailed ? '<br>Report e-mailed to the inbox.' : '') +
    (lastRun.reportError ? `<br><span style="color:var(--bad)">${esc(lastRun.reportError)}</span>` : '') +
    (lastRun.error ? `<br><span style="color:var(--bad)">${esc(lastRun.error)}</span>` : '');
  for (const it of (lastRun.items || []).slice(0, 50)) {
    const li = document.createElement('li');
    const url = `https://mail.google.com/mail/u/${encodeURIComponent(lastRun.account || '0')}/#all/${it.threadId}`;
    li.innerHTML = `<a href="${url}" target="_blank" title="Open in Gmail"><span class="subj">${ICON[it.action] || '•'} ${esc(it.subject || '(no subject)')}</span><span class="muted">${esc(it.detail || '')}</span></a>`;
    list.appendChild(li);
  }
}

async function run(dryRun) {
  if (target && target !== cfg.account.email.toLowerCase()) {
    if (!(await switchInbox(target))) return;
  }
  if (!dryRun && !confirm(`Run now on ${cfg.account.email}?\n\nUp to ${cfg.schedule.batchSize} e-mails will be checked and matching ones answered. Replies cannot be unsent.`)) return;
  const r = await send({ type: 'run', dryRun });
  if (!r?.ok) setStatusHtml(`<span class="pill bad">Could not start</span> ${esc(r?.error)}`);
  else if (r.resumed) setStatusHtml('<span class="pill">Resuming</span> An interrupted run is being finished first.');
}

function downloadReport() {
  if (!lastRun) return;
  const blob = new Blob([reportBytes(lastRun)], { type: XLSX_MIME });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = reportFileName(lastRun);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function emailReport() {
  if (!lastRun) return;
  if (!confirm(`E-mail this run's report to ${lastRun.account}?`)) return;
  const r = await send({ type: 'emailReport', runId: lastRun.id });
  setStatusHtml(r?.ok ? `<span class="pill ok">Sent</span> Report e-mailed to ${esc(r.to)}.` : `<span class="pill bad">Not sent</span> ${esc(r?.error)}`);
}

async function init() {
  cfg = await loadConfig();
  tabEmail = await detectGmailAccount();
  $('#settingsBtn').onclick = () => openSettings(tabEmail && !cfg.configured ? `?email=${encodeURIComponent(tabEmail)}` : '');

  if (!cfg.configured) {
    $('#welcome').classList.remove('hidden');
    $('#welcomeInbox').innerHTML = tabEmail
      ? `Setup will start with the inbox open in this tab: <b>${esc(tabEmail)}</b> (you can choose another).`
      : 'Setup takes about five minutes: inbox, rules, reply text, attachments, handling and schedule.';
    $('#setupBtn').onclick = () => openSettings(tabEmail ? `?email=${encodeURIComponent(tabEmail)}` : '');
    return;
  }

  $('#dash').classList.remove('hidden');
  target = tabEmail || cfg.account.email.toLowerCase();
  renderInboxSelect();
  renderTabNotice();
  $('#runBtn').onclick = () => run(false);
  $('#previewBtn').onclick = () => run(true);
  $('#stopBtn').onclick = async () => { if (confirm('Stop the current run? E-mails already answered stay answered.')) await send({ type: 'stop' }); };
  $('#downloadBtn').onclick = downloadReport;
  $('#emailBtn').onclick = emailReport;
  await renderStatus();
  chrome.storage.onChanged.addListener((ch) => { if (ch.status || ch.runs) renderStatus(); });
}

init();
