import { loadConfig, saveConfig, putFile, deleteFile, getFile } from './lib/store.js';
import { newRule, recruiterTemplate, PLACEHOLDERS, uid } from './lib/defaults.js';
import { MAX_ATTACHMENT_BYTES, MAX_DAILY_CAP } from './lib/config.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const send = (msg) => chrome.runtime.sendMessage(msg);

let cfg;
const pendingDeletes = new Set();
const inlineMeta = new Map();       // id -> {id, name, type, size} for images placed in the reply text
const imageUrls = new Map();        // id -> object URL used to display it in the editor
let selectedImg = null;
let savedRange = null;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
let htmlMode = false;
let connectedEmail = '';

// ---------------------------------------------------------------- steps
const steps = $$('.step');
let current = 0;

function renderNav() {
  const nav = $('#stepNav');
  nav.innerHTML = '';
  steps.forEach((s, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<span class="num">${i + 1}</span> ${s.dataset.title}`;
    if (i === current) b.setAttribute('aria-current', 'step');
    if (i < current) b.classList.add('done');
    b.onclick = () => go(i);
    nav.appendChild(b);
  });
}

function go(i) {
  collect();
  current = Math.max(0, Math.min(steps.length - 1, i));
  steps.forEach((s, j) => s.classList.toggle('active', j === current));
  $('#prevBtn').disabled = current === 0;
  $('#nextBtn').classList.toggle('hidden', current === steps.length - 1);
  $('#stepCount').textContent = `Step ${current + 1} of ${steps.length}`;
  history.replaceState(null, '', '#' + steps[current].dataset.step);
  if (steps[current].dataset.step === 'review') renderReview();
  renderNav();
  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------- load into UI
function setRadio(name, value) {
  const el = $(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
}
const getRadio = (name) => $(`input[name="${name}"]:checked`)?.value;

function fillForm() {
  $('#accountEmail').value = cfg.account.email;
  $('#scopeAfter').value = cfg.scope.after;
  $('#scopeUnread').checked = cfg.scope.unreadOnly;
  $('#scopeSkipReplied').checked = cfg.scope.skipAlreadyReplied;
  $('#scopeExtra').value = cfg.scope.extraQuery;
  setLabelOptions([{ id: cfg.scope.label || 'INBOX', name: cfg.scope.labelName || 'Inbox' }]);

  setRadio('unmatched', cfg.handling.unmatched.action);
  $('#unmatchedLabel').value = cfg.handling.unmatched.label;
  renderRules();

  $('#replySubject').value = cfg.reply.subjectTemplate;
  for (const m of cfg.inlineImages || []) inlineMeta.set(m.id, m);
  renderEditor(cfg.reply.html);
  $('#appendSig').checked = cfg.reply.appendSignature;
  $('#replyAll').checked = cfg.reply.replyAll;

  renderFiles();

  const h = cfg.handling;
  $('#afterLabel').value = h.afterSend.label;
  $('#afterArchive').checked = h.afterSend.archive;
  $('#afterRead').checked = h.afterSend.markRead;
  setRadio('dupPolicy', h.duplicates.policy);
  $('#dupAction').value = h.duplicates.action;
  $('#dupLabel').value = h.duplicates.label;
  $('#relayDomains').value = h.relay.domains;
  $('#relayNoAddr').value = h.relay.noAddress;
  $('#errRetries').value = h.errors.maxRetries;
  $('#errLabel').value = h.errors.label;

  const s = cfg.schedule;
  setRadio('schedMode', s.mode);
  $('#schedEvery').value = String(s.everyMinutes);
  $('#schedTime').value = s.dailyTime;
  $('#schedWeekdays').checked = s.weekdaysOnly;
  $('#batchSize').value = s.batchSize;
  $('#dailyCap').value = s.dailyCap;
  $('#notify').checked = s.notify;
  $('#reportEmail').checked = cfg.report.emailAfterRun;
  $('#reportOnlyActivity').checked = cfg.report.onlyWhenActivity;
  $('#reportPreviews').checked = cfg.report.includePreviews;
}

// ---------------------------------------------------------------- collect from UI
function collect() {
  if (!cfg) return;
  cfg.account.email = $('#accountEmail').value.trim();
  const sel = $('#scopeLabel');
  cfg.scope.label = sel.value;
  cfg.scope.labelName = sel.selectedOptions[0]?.textContent || sel.value;
  cfg.scope.after = $('#scopeAfter').value;
  cfg.scope.unreadOnly = $('#scopeUnread').checked;
  cfg.scope.skipAlreadyReplied = $('#scopeSkipReplied').checked;
  cfg.scope.extraQuery = $('#scopeExtra').value.trim();

  collectRules();
  cfg.handling.unmatched = { action: getRadio('unmatched') || 'leave', label: $('#unmatchedLabel').value.trim() };

  cfg.reply.subjectTemplate = $('#replySubject').value || 'Re: {{subject}}';
  cfg.reply.html = toStored(htmlMode ? $('#htmlSource').value : $('#editor').innerHTML);
  cfg.inlineImages = referencedImages(cfg.reply.html).map((id) => inlineMeta.get(id)).filter(Boolean);
  cfg.reply.text = editorText();
  cfg.reply.appendSignature = $('#appendSig').checked;
  cfg.reply.replyAll = $('#replyAll').checked;

  const h = cfg.handling;
  h.afterSend = { label: $('#afterLabel').value.trim(), archive: $('#afterArchive').checked, markRead: $('#afterRead').checked };
  h.duplicates = { policy: getRadio('dupPolicy') || 'newest', action: $('#dupAction').value, label: $('#dupLabel').value.trim() };
  h.relay = { domains: $('#relayDomains').value, noAddress: $('#relayNoAddr').value };
  h.errors = { maxRetries: clamp(+$('#errRetries').value, 1, 10, 3), label: $('#errLabel').value.trim() };

  const s = cfg.schedule;
  s.mode = getRadio('schedMode') || 'off';
  s.everyMinutes = +$('#schedEvery').value;
  s.dailyTime = $('#schedTime').value || '08:00';
  s.weekdaysOnly = $('#schedWeekdays').checked;
  s.batchSize = clamp(+$('#batchSize').value, 1, 500, 25);
  s.dailyCap = clamp(+$('#dailyCap').value, 1, MAX_DAILY_CAP, 100);
  s.notify = $('#notify').checked;
  cfg.report = { emailAfterRun: $('#reportEmail').checked, onlyWhenActivity: $('#reportOnlyActivity').checked, includePreviews: $('#reportPreviews').checked };
}

function clamp(v, lo, hi, dflt) { return Number.isFinite(v) && v > 0 ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt; }

// ---------------------------------------------------------------- inbox / connect
function setLabelOptions(labels) {
  const sel = $('#scopeLabel');
  const keep = cfg.scope.label || 'INBOX';
  const sys = { INBOX: 'Inbox', IMPORTANT: 'Important', STARRED: 'Starred', CATEGORY_PERSONAL: 'Primary', CATEGORY_UPDATES: 'Updates', CATEGORY_PROMOTIONS: 'Promotions', CATEGORY_SOCIAL: 'Social', CATEGORY_FORUMS: 'Forums' };
  const opts = [];
  for (const l of labels) {
    if (l.type === 'system' && !sys[l.id]) continue;
    opts.push({ id: l.id, name: sys[l.id] || l.name });
  }
  if (!opts.some((o) => o.id === 'INBOX')) opts.unshift({ id: 'INBOX', name: 'Inbox' });
  opts.sort((a, b) => (a.id === 'INBOX' ? -1 : b.id === 'INBOX' ? 1 : a.name.localeCompare(b.name)));
  sel.innerHTML = '';
  for (const o of opts) sel.add(new Option(o.name, o.id, false, o.id === keep));
}

async function refreshLabels(email) {
  const r = await send({ type: 'listLabels', email });
  if (r?.ok) setLabelOptions(r.labels);
  return r;
}

async function doConnect() {
  const email = $('#accountEmail').value.trim();
  const st = $('#connectStatus');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { st.innerHTML = '<span class="pill bad">Enter a valid e-mail address</span>'; return; }
  st.textContent = 'Opening Google sign-in…';
  const r = await send({ type: 'connect', email });
  if (!r?.ok) { st.innerHTML = `<span class="pill bad">Not connected</span> ${escape(r?.error || 'Unknown error')}`; return; }
  connectedEmail = r.email;
  cfg.account.email = r.email;
  cfg.account.connected = true;
  $('#accountEmail').value = r.email;
  st.innerHTML = `<span class="pill ok">Connected</span> ${escape(r.email)}`;
  await refreshLabels(r.email);
}

// ---------------------------------------------------------------- rules
function renderRules() {
  const list = $('#rulesList');
  list.innerHTML = '';
  if (!cfg.rules.length) {
    list.innerHTML = '<p class="muted">No rules yet. Add one, or load the starter rules and adjust them.</p>';
    return;
  }
  cfg.rules.forEach((r, i) => {
    const el = $('#ruleTpl').content.firstElementChild.cloneNode(true);
    el.dataset.id = r.id;
    $('.r-enabled', el).checked = r.enabled;
    $('.r-name', el).value = r.name;
    $('.r-include', el).value = r.include;
    $('.r-exclude', el).value = r.exclude;
    $('.r-f-subject', el).checked = !!r.fields.subject;
    $('.r-f-body', el).checked = !!r.fields.body;
    $('.r-f-sender', el).checked = !!r.fields.sender;
    $('.r-mode', el).value = r.matchMode;
    $('.r-action', el).value = r.action;
    $('.r-label', el).value = r.label;
    $('.r-archive', el).checked = r.archive;
    $('.r-read', el).checked = r.markRead;
    const sync = () => {
      const a = $('.r-action', el).value;
      $('.r-label', el).classList.toggle('hidden', a === 'reply');
      $('.r-label', el).placeholder = a === 'leave' ? 'Optional label' : 'Label name';
      $('.r-archive-wrap', el).classList.toggle('hidden', a !== 'label');
      $('.r-read-wrap', el).classList.toggle('hidden', a !== 'label');
      el.classList.toggle('off', !$('.r-enabled', el).checked);
    };
    el.addEventListener('change', sync);
    sync();
    $('.r-up', el).disabled = i === 0;
    $('.r-down', el).disabled = i === cfg.rules.length - 1;
    $('.r-up', el).onclick = () => moveRule(i, -1);
    $('.r-down', el).onclick = () => moveRule(i, 1);
    $('.r-del', el).onclick = () => { collectRules(); cfg.rules.splice(i, 1); renderRules(); };
    list.appendChild(el);
  });
}

function collectRules() {
  const els = $$('#rulesList .rule');
  if (!els.length && cfg.rules.length) return;
  cfg.rules = els.map((el) => ({
    id: el.dataset.id || uid(),
    enabled: $('.r-enabled', el).checked,
    name: $('.r-name', el).value.trim() || 'Untitled rule',
    include: $('.r-include', el).value,
    exclude: $('.r-exclude', el).value,
    matchMode: $('.r-mode', el).value,
    fields: { subject: $('.r-f-subject', el).checked, body: $('.r-f-body', el).checked, sender: $('.r-f-sender', el).checked },
    action: $('.r-action', el).value,
    label: $('.r-label', el).value.trim(),
    archive: $('.r-archive', el).checked,
    markRead: $('.r-read', el).checked,
  }));
}

function moveRule(i, d) {
  collectRules();
  const j = i + d;
  [cfg.rules[i], cfg.rules[j]] = [cfg.rules[j], cfg.rules[i]];
  renderRules();
}

// ---------------------------------------------------------------- rich text editor
const ALLOWED = new Set(['DIV', 'P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'SPAN', 'FONT', 'A', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'IMG', 'HR', 'SUB', 'SUP']);
const ATTRS = new Set(['style', 'href', 'color', 'face', 'size', 'target', 'src', 'alt', 'width', 'height', 'align', 'colspan', 'rowspan', 'title', 'data-emgr']);

function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  (function clean(node) {
    for (const child of [...node.children]) {
      if (!ALLOWED.has(child.tagName)) {
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'META', 'LINK'].includes(child.tagName)) { child.remove(); continue; }
        child.replaceWith(...child.childNodes);
        clean(node);
        return;
      }
      for (const a of [...child.attributes]) {
        const n = a.name.toLowerCase();
        const v = a.value.trim();
        if (!ATTRS.has(n)) { child.removeAttribute(a.name); continue; }
        if (n === 'href' && !/^(https?:|mailto:|tel:)/i.test(v)) child.removeAttribute(a.name);
        if (n === 'src' && !/^(https:|blob:|emgr-inline:[\w-]+$)/i.test(v)) child.removeAttribute(a.name);
        if (n === 'style' && /(expression|javascript:|url\s*\()/i.test(v)) child.removeAttribute(a.name);
      }
      if (child.tagName === 'A') child.setAttribute('target', '_blank');
      clean(child);
    }
  })(root);
  return root.innerHTML;
}

function editorText() {
  const div = document.createElement('div');
  div.style.cssText = 'position:absolute;left:-9999px;white-space:pre-wrap';
  div.innerHTML = cfg.reply.html;
  document.body.appendChild(div);
  const t = div.innerText.replace(/\n{3,}/g, '\n\n').trim();
  div.remove();
  return t;
}

function setupEditor() {
  const editor = $('#editor');
  document.execCommand('styleWithCSS', false, true);
  document.execCommand('defaultParagraphSeparator', false, 'div');
  for (const el of $$('#toolbar [data-cmd]')) {
    const cmd = el.dataset.cmd;
    const run = (value = null) => { editor.focus(); document.execCommand(cmd, false, value); };
    if (el.tagName === 'SELECT') {
      el.onchange = () => { if (el.value) run(el.value); el.value = ''; };
    } else if (el.type === 'color') {
      el.oninput = () => run(el.value);
    } else if (cmd === 'createLink') {
      el.onclick = () => {
        const url = prompt('Link address (https://…)', 'https://');
        if (url && /^(https?:|mailto:)/i.test(url)) run(url);
      };
    } else {
      el.onmousedown = (e) => e.preventDefault();      // keep the text selection
      el.onclick = () => run();
    }
  }
  const ph = $('#placeholderSel');
  for (const [token, label] of PLACEHOLDERS) ph.add(new Option(`${label}  ${token}`, token));
  ph.onchange = () => {
    if (!ph.value) return;
    if (htmlMode) { insertAtCursor($('#htmlSource'), ph.value); } else { editor.focus(); document.execCommand('insertText', false, ph.value); }
    ph.value = '';
  };
  $('#toggleHtml').onclick = () => {
    htmlMode = !htmlMode;
    if (htmlMode) {
      $('#htmlSource').value = toStored(editor.innerHTML);
    } else {
      renderEditor($('#htmlSource').value);
    }
    $('#insertImageBtn').disabled = htmlMode;
    editor.classList.toggle('hidden', htmlMode);
    $('#htmlSource').classList.toggle('hidden', !htmlMode);
    $$('#toolbar [data-cmd]').forEach((b) => { b.disabled = htmlMode; });
  };
  editor.addEventListener('paste', (e) => {            // paste images, or clean HTML
    const imgs = [...(e.clipboardData.files || [])].filter((f) => f.type.startsWith('image/'));
    if (imgs.length) { e.preventDefault(); insertImages(imgs); return; }
    const html = e.clipboardData.getData('text/html');
    if (!html) return;
    e.preventDefault();
    document.execCommand('insertHTML', false, sanitize(html));
  });
}

// ---------------------------------------------------------------- images in the reply text
// Stored HTML refers to images as src="emgr-inline:<id>"; the files live in IndexedDB.
// When a reply is sent they become inline parts referenced by Content-ID.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function referencedImages(html) {
  return [...new Set([...String(html || '').matchAll(/emgr-inline:([\w-]+)/g)].map((m) => m[1]))];
}

/** Editor HTML → stored HTML (blob: previews become emgr-inline: references). */
function toStored(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  for (const img of doc.querySelectorAll('img')) {
    const id = img.getAttribute('data-emgr');
    if (id) img.setAttribute('src', 'emgr-inline:' + id);
    else if (/^blob:/i.test(img.getAttribute('src') || '')) { img.remove(); continue; }
    img.removeAttribute('data-emgr');
    img.removeAttribute('class');
  }
  return sanitize(doc.body.firstElementChild.innerHTML);
}

/** Stored HTML → editor, loading each image's preview from IndexedDB. */
async function renderEditor(html) {
  const editor = $('#editor');
  editor.innerHTML = sanitize(html);
  for (const img of editor.querySelectorAll('img[src^="emgr-inline:"]')) {
    const id = img.getAttribute('src').slice('emgr-inline:'.length);
    img.setAttribute('data-emgr', id);
    let url = imageUrls.get(id);
    if (!url) {
      const rec = await getFile(id).catch(() => null);
      if (!rec) { img.alt = '(missing image — insert it again)'; continue; }
      url = URL.createObjectURL(rec.blob);
      imageUrls.set(id, url);
      if (!inlineMeta.has(id)) inlineMeta.set(id, { id, name: rec.name, type: rec.type, size: rec.size });
    }
    img.src = url;
  }
}

function imageBytesInUse() {
  const html = toStored($('#editor').innerHTML);
  return referencedImages(html).reduce((a, id) => a + (inlineMeta.get(id)?.size || 0), 0);
}

function naturalWidth(url) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im.naturalWidth || 400);
    im.onerror = () => resolve(400);
    im.src = url;
  });
}

async function insertImages(files) {
  const problems = [];
  const editor = $('#editor');
  for (const file of files) {
    if (!IMAGE_TYPES.includes(file.type)) { problems.push(`"${file.name}" is not a PNG, JPG, GIF or WebP image.`); continue; }
    if (file.size > MAX_IMAGE_BYTES) { problems.push(`"${file.name}" is larger than 5 MB.`); continue; }
    if (totalSize() + imageBytesInUse() + file.size > MAX_ATTACHMENT_BYTES) { problems.push(`"${file.name}" skipped — images and attachments together must stay under 20 MB.`); continue; }
    const rec = { id: uid(), name: file.name || 'image.png', type: file.type, size: file.size };
    await putFile({ ...rec, blob: file });
    inlineMeta.set(rec.id, rec);
    const url = URL.createObjectURL(file);
    imageUrls.set(rec.id, url);
    const w = Math.min(await naturalWidth(url), 600);
    editor.focus();
    const sel = window.getSelection();
    if (savedRange) { sel.removeAllRanges(); sel.addRange(savedRange); savedRange = null; }
    else if (!sel.rangeCount || !editor.contains(sel.anchorNode)) {
      const r = document.createRange(); r.selectNodeContents(editor); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
    }
    const alt = file.name.replace(/\.[^.]+$/, '').replace(/["<>&]/g, '');
    document.execCommand('insertHTML', false, `<img src="${url}" data-emgr="${rec.id}" alt="${alt}" width="${w}">`);
  }
  if (problems.length) alert(problems.join('\n'));
}

function selectImage(img) {
  if (selectedImg) selectedImg.classList.remove('sel');
  selectedImg = img;
  const sizeSel = $('#imageWidth');
  if (img) { img.classList.add('sel'); sizeSel.classList.remove('hidden'); } else { sizeSel.classList.add('hidden'); }
}

function setupImages() {
  const editor = $('#editor');
  const input = $('#imageInput');
  const btn = $('#insertImageBtn');
  btn.onmousedown = (e) => {
    e.preventDefault();
    const sel = window.getSelection();
    savedRange = sel.rangeCount && editor.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  };
  btn.onclick = () => input.click();
  input.onchange = async () => { await insertImages([...input.files]); input.value = ''; };
  editor.addEventListener('click', (e) => selectImage(e.target.tagName === 'IMG' ? e.target : null));
  editor.addEventListener('dragover', (e) => { if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) e.preventDefault(); });
  editor.addEventListener('drop', (e) => {
    const imgs = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    e.preventDefault();
    const pos = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    savedRange = pos && editor.contains(pos.startContainer) ? pos : null;
    insertImages(imgs);
  });
  $('#imageWidth').onchange = (e) => {
    const v = e.target.value;
    if (selectedImg && v) {
      if (v === 'orig') { selectedImg.removeAttribute('width'); selectedImg.style.width = ''; }
      else if (v === 'full') { selectedImg.removeAttribute('width'); selectedImg.style.width = '100%'; }
      else { selectedImg.setAttribute('width', v); selectedImg.style.width = ''; }
    }
    e.target.value = '';
  };
}

function insertAtCursor(ta, text) {
  const s = ta.selectionStart; const e = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + text.length;
  ta.focus();
}

// ---------------------------------------------------------------- attachments
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const totalSize = () => cfg.attachments.reduce((a, f) => a + (f.size || 0), 0);  // attachment files only

function renderFiles() {
  const ul = $('#fileList');
  ul.innerHTML = '';
  for (const f of cfg.attachments) {
    const li = document.createElement('li');
    li.innerHTML = `<span>📎 <b></b> <span class="muted small"></span></span>`;
    $('b', li).textContent = f.name;
    $('.muted', li).textContent = fmtSize(f.size);
    const rm = document.createElement('button');
    rm.className = 'link danger';
    rm.textContent = 'Remove';
    rm.onclick = () => { pendingDeletes.add(f.id); cfg.attachments = cfg.attachments.filter((x) => x.id !== f.id); renderFiles(); };
    li.appendChild(rm);
    ul.appendChild(li);
  }
  $('#fileTotal').textContent = cfg.attachments.length
    ? `${cfg.attachments.length} file(s), ${fmtSize(totalSize())} of 20 MB`
    : 'No attachments — replies will be sent without files.';
}

async function addFiles(fileList) {
  const msgs = [];
  for (const file of fileList) {
    if (totalSize() + imageBytesInUse() + file.size > MAX_ATTACHMENT_BYTES) { msgs.push(`"${file.name}" skipped — attachments and images together must stay under 20 MB.`); continue; }
    if (cfg.attachments.some((a) => a.name === file.name && a.size === file.size)) continue;
    const rec = { id: uid(), name: file.name, type: file.type || 'application/octet-stream', size: file.size };
    await putFile({ ...rec, blob: file });
    cfg.attachments.push(rec);
  }
  renderFiles();
  if (msgs.length) $('#fileTotal').textContent += ' ' + msgs.join(' ');
}

function setupFiles() {
  const input = $('#fileInput');
  input.onchange = () => { addFiles([...input.files]); input.value = ''; };
  const dz = $('#dropZone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); addFiles([...e.dataTransfer.files]); });
}

// ---------------------------------------------------------------- review & save
function escape(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function issues() {
  const out = [];
  if (!cfg.account.email) out.push(['Inbox', 'Enter the e-mail address to work on.']);
  else if (!cfg.account.connected && !connectedEmail) out.push(['Inbox', 'Click Connect so Google can approve access.']);
  if (!cfg.rules.some((r) => r.enabled && r.action === 'reply')) out.push(['Rules', 'No enabled rule sends a reply.']);
  for (const r of cfg.rules) {
    if (r.enabled && !r.include.trim()) out.push(['Rules', `Rule "${r.name}" has no keywords, so it never matches.`]);
    if (r.enabled && !r.fields.subject && !r.fields.body && !r.fields.sender) out.push(['Rules', `Rule "${r.name}" does not look anywhere (tick subject, message or sender).`]);
    if (r.enabled && r.action === 'label' && !r.label) out.push(['Rules', `Rule "${r.name}" adds a label but no label name is set.`]);
  }
  if (cfg.handling.unmatched.action === 'label' && !cfg.handling.unmatched.label) out.push(['Rules', 'Choose a label name for e-mails that match no rule.']);
  if (!cfg.reply.text.trim()) out.push(['Reply text', 'The reply message is empty.']);
  return out;
}

function renderReview() {
  collect();
  const s = cfg.schedule;
  const sched = s.mode === 'off' ? 'Only when you click Run now'
    : s.mode === 'interval' ? `Every ${$('#schedEvery').selectedOptions[0].textContent}`
    : `Daily at ${s.dailyTime}${s.weekdaysOnly ? ' (weekdays)' : ''}`;
  const rows = [
    ['Inbox', `${escape(cfg.account.email || '—')} · ${escape(cfg.scope.labelName)}${cfg.scope.unreadOnly ? ' · unread only' : ''}${cfg.scope.after ? ' · since ' + escape(cfg.scope.after) : ''}`],
    ['Rules', cfg.rules.filter((r) => r.enabled).map((r, i) => `${i + 1}. ${escape(r.name)} → ${{ reply: 'reply', label: 'label "' + escape(r.label) + '"', leave: 'leave for review' }[r.action]}`).join('<br>') || '—'],
    ['Reply', `<i>${escape(cfg.reply.subjectTemplate)}</i><br>${escape(cfg.reply.text.slice(0, 160))}${cfg.reply.text.length > 160 ? '…' : ''}${cfg.inlineImages?.length ? `<br>+ ${cfg.inlineImages.length} image(s) in the text` : ''}${cfg.reply.appendSignature ? '<br>+ Gmail signature' : ''}`],
    ['Attachments', cfg.attachments.map((a) => escape(a.name)).join(', ') || 'None'],
    ['After sending', [cfg.handling.afterSend.label && `label "${escape(cfg.handling.afterSend.label)}"`, cfg.handling.afterSend.archive && 'archive', cfg.handling.afterSend.markRead && 'mark read'].filter(Boolean).join(', ') || 'Nothing'],
    ['Schedule', `${sched} · ${s.batchSize} e-mails per run · max ${s.dailyCap} replies/day`],
  ];
  const probs = issues();
  $('#reviewBox').innerHTML = `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` +
    (probs.length
      ? `<div class="notice bad issues"><b>Please fix before saving:</b><ul>${probs.map(([st, m]) => `<li><a href="#" data-goto="${st}">${st}</a>: ${escape(m)}</li>`).join('')}</ul></div>`
      : '<div class="notice issues">Everything looks good. Tip: use <b>Save & preview</b> first — it shows what would happen without sending anything.</div>');
  $$('[data-goto]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); go(steps.findIndex((s) => s.dataset.title.startsWith(a.dataset.goto))); }; });
  for (const id of ['saveBtn', 'previewBtn', 'runBtn']) $('#' + id).disabled = probs.length > 0;
}

let save = async function save() {
  collect();
  if (issues().length) { renderReview(); return false; }
  cfg.configured = true;
  await saveConfig(cfg);
  for (const id of pendingDeletes) await deleteFile(id);
  pendingDeletes.clear();
  const used = new Set(referencedImages(cfg.reply.html));
  for (const id of [...inlineMeta.keys()]) {
    if (!used.has(id)) { await deleteFile(id); inlineMeta.delete(id); }
  }
  await send({ type: 'configSaved' });
  $('#saveMsg').innerHTML = '<span class="pill ok">Saved</span> Click the E-Mail Manager button in the toolbar any time to run it or see results.';
  return true;
};

async function saveAndRun(dryRun) {
  collect();
  if (!dryRun && !confirm(`Send replies now from ${cfg.account.email}?\n\nUp to ${cfg.schedule.batchSize} e-mails will be checked and matching ones answered (max ${cfg.schedule.dailyCap} replies per day). Replies cannot be unsent.\n\nTip: choose Cancel, then "Save & preview" to see what would happen first.`)) return;
  if (!(await save())) return;
  const r = await send({ type: 'run', dryRun });
  $('#saveMsg').innerHTML = r?.ok
    ? `<span class="pill">${dryRun ? 'Preview' : 'Run'} started</span> Progress and results appear here and in the toolbar button.`
    : `<span class="pill bad">Could not start</span> ${escape(r?.error)}`;
}

chrome.storage.onChanged.addListener((ch) => {
  if (!ch.status) return;
  const st = ch.status.newValue || {};
  const box = $('#saveMsg');
  if (st.running) box.innerHTML = `<span class="pill">Running</span> ${escape(st.progress || '')}`;
  else if (st.lastError) box.innerHTML = `<span class="pill bad">Problem</span> ${escape(st.lastError)}`;
  else if (st.lastSummary) box.innerHTML = `<span class="pill ok">Done</span> ${escape(st.lastSummary)} Open the toolbar button for details.`;
});

// ---------------------------------------------------------------- init
async function init() {
  cfg = await loadConfig();
  // Opened from the toolbar while viewing a Gmail inbox: suggest that inbox.
  const suggested = new URLSearchParams(location.search).get('email');
  if (suggested && suggested.toLowerCase() !== cfg.account.email.toLowerCase()) {
    if (!cfg.account.email || confirm(`You opened E-Mail Manager from ${suggested}.\n\nUse ${suggested} as the inbox to work on?${cfg.account.email ? `\n(Currently set to ${cfg.account.email}.)` : ''}`)) {
      cfg.account = { email: suggested, connected: false };
    }
  }
  fillForm();
  setupEditor();
  setupImages();
  setupFiles();

  $('#connectBtn').onclick = doConnect;
  $('#addRule').onclick = () => { collectRules(); cfg.rules.push(newRule()); renderRules(); };
  $('#loadTemplate').onclick = () => {
    collectRules();
    if (cfg.rules.length && !confirm('Add the starter rules below your current rules?')) return;
    cfg.rules.push(...recruiterTemplate());
    renderRules();
  };
  $('#prevBtn').onclick = () => go(current - 1);
  $('#nextBtn').onclick = () => go(current + 1);
  $('#saveBtn').onclick = () => save();
  $('#previewBtn').onclick = () => saveAndRun(true);
  $('#runBtn').onclick = () => saveAndRun(false);
  $('#resetHistory').onclick = async () => {
    if (confirm('Forget which e-mails were already handled? They may be checked (and replied to) again.')) {
      await send({ type: 'resetHistory', email: cfg.account.email });
      $('#saveMsg').textContent = 'History cleared.';
    }
  };
  $('#disconnectBtn').onclick = async () => {
    if (!confirm(`Disconnect ${cfg.account.email}? Scheduled runs will stop until you connect again.`)) return;
    await send({ type: 'disconnect', email: cfg.account.email });
    cfg.account.connected = false; connectedEmail = '';
    collect(); await saveConfig({ ...cfg, configured: false });
    $('#connectStatus').innerHTML = '<span class="pill warn">Disconnected</span>';
    $('#saveMsg').textContent = 'Disconnected. Scheduled runs are paused until you connect and save again.';
    await send({ type: 'configSaved' });
  };

  if (cfg.account.connected && cfg.account.email) {
    $('#connectStatus').innerHTML = `<span class="pill ok">Connected</span> ${escape(cfg.account.email)}`;
    refreshLabels(cfg.account.email).then((r) => {
      if (r && !r.ok) $('#connectStatus').innerHTML = `<span class="pill warn">Reconnect needed</span> ${escape(r.error)}`;
    });
  }

  const start = steps.findIndex((s) => s.dataset.step === location.hash.slice(1));
  go(start >= 0 ? start : 0);
  window.addEventListener('hashchange', () => {
    const i = steps.findIndex((s) => s.dataset.step === location.hash.slice(1));
    if (i >= 0 && i !== current) go(i);
  });
}

let saved = true;
document.addEventListener('input', () => { saved = false; });
window.addEventListener('beforeunload', (e) => { if (!saved) { e.preventDefault(); e.returnValue = ''; } });
const _save = save;
save = async () => { const ok = await _save(); if (ok) saved = true; return ok; };

init();
