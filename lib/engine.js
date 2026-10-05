// The run engine: finds candidate threads, applies rules and handling options.
// Pure of chrome.* APIs so it can be unit-tested with fakes (see tests/).
import { compileRule, evaluate, parseList } from './rules.js';
import { summarize, buildMessage, fillPlaceholders, htmlToText } from './mime.js';
import { LabelResolver } from './gmail.js';

const EMAIL_RE = /[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/g;
const BOT_RE = /(no-?reply|do-?not-?reply|donotreply|mailer-daemon|notifications?@|unsubscribe|bounce)/i;

export function buildQuery(scope) {
  const q = [];
  if (scope.unreadOnly) q.push('is:unread');
  if (scope.after) q.push('after:' + scope.after.replace(/-/g, '/'));
  q.push('-in:chats');
  if (scope.extraQuery) q.push(scope.extraQuery.trim());
  return q.join(' ');
}

export function normalizeSubject(s) {
  return String(s || '')
    .replace(/^\s*((re|fw|fwd|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function stripReplyPrefix(s) {
  return String(s || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '');
}

function domainOf(email) { return (email.split('@')[1] || '').toLowerCase(); }

function isRelay(email, relayDomains) {
  const d = domainOf(email);
  return relayDomains.some((r) => d === r || d.endsWith('.' + r));
}

/** Picks the human recruiter address out of a relayed message body. */
export function findRelayContact(body, { relayDomains, me }) {
  for (const m of String(body || '').matchAll(EMAIL_RE)) {
    const e = m[0].toLowerCase().replace(/[.]+$/, '');
    if (e === me || BOT_RE.test(e) || isRelay(e, relayDomains)) continue;
    if (/\.(png|jpe?g|gif|webp)$/.test(e)) continue;
    return e;
  }
  return '';
}

/**
 * @param {object} p
 * @param {object} p.config            full settings object
 * @param {Gmail}  p.gmail             API client
 * @param {object} p.state             persistent state (mutated)
 * @param {Function} p.loadAttachments () => Promise<[{name,type,bytes}]>
 * @param {Function} [p.loadInlineImages] (ids) => Promise<[{id,name,type,bytes}]> images placed in the reply text
 * @param {Function} [p.getSignature]  () => Promise<string html>
 * @param {boolean} [p.dryRun]
 * @param {Function} [p.onProgress]    (text) => void
 * @param {Function} [p.now]
 */
export async function runEngine({ config, gmail, state, loadAttachments, loadInlineImages = async () => [], getSignature, dryRun = false, onProgress = () => {}, onCheckpoint = async () => {}, shouldStop = () => false, resumeFrom = null, now = () => Date.now() }) {
  const me = config.account.email.toLowerCase();
  const scope = config.scope;
  const h = config.handling;
  const sched = config.schedule;
  const rules = (config.rules || []).map(compileRule);
  const relayDomains = parseList(h.relay.domains).map((d) => d.toLowerCase().replace(/^@/, ''));
  const labels = new LabelResolver(gmail, { dryRun });
  const batch = Math.max(1, Number(sched.batchSize) || 25);
  const sentToday = (state.sentLog || []).filter((t) => t > now() - 864e5).length;
  let sendBudget = Math.max(0, (Number(sched.dailyCap) || 100) - sentToday);

  const run = resumeFrom ? { ...resumeFrom, counts: { ...resumeFrom.counts }, items: [...(resumeFrom.items || [])], resumedAt: now(), resumes: (resumeFrom.resumes || 0) + 1 } : {
    id: now().toString(36),
    startedAt: now(),
    account: me,
    dryRun,
    counts: { evaluated: 0, replied: 0, labeled: 0, left: 0, skipped: 0, duplicates: 0, errors: 0 },
    items: [],
    stoppedReason: '',
  };
  const record = (item) => { if (run.items.length < 500) run.items.push(item); };

  let attachments = null;
  let inlineImages = null;
  let signature = null;
  const inlineIds = [...new Set([...String(config.reply.html || '').matchAll(/emgr-inline:([\w-]+)/g)].map((m) => m[1]))];
  async function replyPayload() {
    if (!attachments) attachments = await loadAttachments();
    if (!inlineImages) {
      inlineImages = inlineIds.length
        ? (await loadInlineImages(inlineIds)).map((img) => ({ ...img, cid: `${img.id}@email-manager` }))
        : [];
    }
    if (signature === null) signature = config.reply.appendSignature && getSignature ? (await getSignature()) || '' : '';
    return { attachments, inlineImages, signature };
  }

  async function apply(threadId, { add = [], remove = [] }) {
    const addIds = [];
    for (const name of add) { const id = await labels.id(name); if (id) addIds.push(id); }
    if (!dryRun) await gmail.modifyThread(threadId, addIds, remove);
  }

  let lastMsgId = '';
  const markDone = (t) => {
    if (!dryRun) { state.processed[t.id] = { h: t.historyId, m: lastMsgId }; delete state.failures[t.id]; }
  };

  let pageToken;
  outer: while (run.counts.evaluated < batch) {
    const page = await gmail.listThreads({
      q: buildQuery(scope), pageToken, maxResults: 50,
      labelIds: scope.label ? [scope.label] : undefined,
    });
    const list = page?.threads || [];
    for (const t of list) {
      if (run.counts.evaluated >= batch) break outer;
      if (shouldStop()) { run.stoppedReason = 'Stopped by you'; break outer; }
      const prev = state.processed[t.id];
      if (prev && prev.h === t.historyId) continue;

      let item = { threadId: t.id };
      lastMsgId = '';
      try {
        const thread = await gmail.getThread(t.id);
        const lastId = thread.messages?.[thread.messages.length - 1]?.id;
        if (prev && prev.m === lastId) {            // only labels changed since we handled it
          if (!dryRun) prev.h = t.historyId;
          continue;
        }
        run.counts.evaluated++;
        lastMsgId = lastId;
        const msgs = (thread.messages || []).map(summarize);
        const incoming = msgs.filter((m) => !m.labelIds.includes('SENT') && m.fromEmail !== me);
        const latest = incoming[incoming.length - 1] || msgs[msgs.length - 1];
        item = { threadId: t.id, subject: latest.subject, from: latest.fromEmail, at: latest.date };
        onProgress(`Checking ${run.counts.evaluated}/${batch}: ${latest.subject || '(no subject)'}`);

        // 1. Threads you already answered.
        const alreadyReplied = msgs.some((m) => m.labelIds.includes('SENT') || m.fromEmail === me);
        if (scope.skipAlreadyReplied && alreadyReplied) {
          run.counts.skipped++;
          record({ ...item, action: 'skipped', detail: 'You already replied in this thread' });
          markDone(t);
          continue;
        }

        // 2. Rules.
        const rule = evaluate(rules, latest);
        if (!rule) {
          if (h.unmatched.action === 'label' && h.unmatched.label) {
            await apply(t.id, { add: [h.unmatched.label] });
            run.counts.labeled++;
            record({ ...item, action: 'labeled', detail: `No rule matched → "${h.unmatched.label}"` });
          } else {
            run.counts.left++;
            record({ ...item, action: 'left', detail: 'No rule matched' });
          }
          markDone(t);
          continue;
        }
        item.rule = rule.name;

        if (rule.action === 'leave') {
          if (rule.label) await apply(t.id, { add: [rule.label] });
          run.counts.left++;
          record({ ...item, action: 'left', detail: `Rule "${rule.name}": left for manual review` });
          markDone(t);
          continue;
        }

        if (rule.action === 'label') {
          const remove = [];
          if (rule.archive && scope.label) remove.push(scope.label);
          if (rule.markRead) remove.push('UNREAD');
          await apply(t.id, { add: rule.label ? [rule.label] : [], remove });
          run.counts.labeled++;
          record({ ...item, action: 'labeled', detail: `Rule "${rule.name}" → "${rule.label || '(no label)'}"` });
          markDone(t);
          continue;
        }

        // 3. Reply: pick the recipient.
        let to = latest.replyTo || latest.fromEmail;
        if (isRelay(to, relayDomains) || isRelay(latest.fromEmail, relayDomains)) {
          const contact = findRelayContact(latest.body, { relayDomains, me });
          if (contact) {
            to = contact;
          } else if (h.relay.noAddress !== 'replyRelay') {
            run.counts.left++;
            record({ ...item, action: 'left', detail: 'Relay sender and no recruiter address found in the message' });
            markDone(t);
            continue;
          }
        }
        if (!to || BOT_RE.test(to)) {
          run.counts.left++;
          record({ ...item, action: 'left', detail: 'No reply address (sender is a no-reply address)' });
          markDone(t);
          continue;
        }

        // 4. Duplicates: same subject to the same recipient/company.
        const dom = domainOf(to);
        const key = normalizeSubject(latest.subject) + '|' + (['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com'].includes(dom) ? to : dom);
        if (h.duplicates.policy === 'newest' && state.repliedKeys[key]) {
          if (h.duplicates.action === 'label' && h.duplicates.label) await apply(t.id, { add: [h.duplicates.label] });
          run.counts.duplicates++;
          record({ ...item, action: 'duplicate', detail: 'Same role already answered — not replied' });
          markDone(t);
          continue;
        }

        if (sendBudget <= 0) {
          run.stoppedReason = `Daily send limit (${sched.dailyCap}) reached`;
          record({ ...item, action: 'deferred', detail: run.stoppedReason });
          break outer;
        }

        // 5. Build and send.
        const { attachments: files, inlineImages: images, signature: sig } = await replyPayload();
        const vars = {
          sender_name: latest.fromName || to,
          sender_first_name: (latest.fromName || '').split(/\s+/)[0] || 'there',
          subject: stripReplyPrefix(latest.subject),
          my_email: me,
        };
        // Images placed in the reply are sent inside the message and referenced by Content-ID.
        let html = fillPlaceholders(config.reply.html, vars, { html: true })
          .replace(/emgr-inline:([\w-]+)/g, 'cid:$1@email-manager');
        let text = fillPlaceholders(config.reply.text || htmlToText(config.reply.html), vars);
        if (sig) { html += `<br><div class="gmail_signature">${sig}</div>`; text += '\n\n' + htmlToText(sig); }
        const cc = config.reply.replyAll
          ? [...new Set([...latest.to, ...latest.cc])].filter((e) => e !== me && e !== to && !isRelay(e, relayDomains))
          : [];
        const subject = fillPlaceholders(config.reply.subjectTemplate || 'Re: {{subject}}', vars);
        item.to = to;

        if (dryRun) {
          run.counts.replied++;
          state.repliedKeys[key] = now();     // so later duplicates in the same preview show correctly
          record({ ...item, action: 'would-reply', detail: `Would reply to ${to}${files.length ? ` with ${files.length} attachment(s)` : ''}${images.length ? `${files.length ? ' and' : ' with'} ${images.length} image(s) in the text` : ''}` });
          continue;
        }

        const mime = buildMessage({
          from: me, to: [to], cc, subject,
          inReplyTo: latest.messageId, references: latest.references,
          html, text, attachments: files, inline: images,
        });
        await gmail.sendRaw(mime, t.id);
        sendBudget--;
        state.sentLog.push(now());
        state.repliedKeys[key] = now();

        const remove = [];
        if (h.afterSend.archive && scope.label) remove.push(scope.label);
        if (h.afterSend.markRead) remove.push('UNREAD');
        await apply(t.id, { add: h.afterSend.label ? [h.afterSend.label] : [], remove });
        run.counts.replied++;
        record({ ...item, action: 'replied', detail: `Replied to ${to}` });
        markDone(t);
      } catch (e) {
        if (e.name === 'AuthError') throw e;
        run.counts.errors++;
        const n = (state.failures[t.id] || 0) + 1;
        if (!dryRun) state.failures[t.id] = n;
        let detail = e.message;
        if (!dryRun && n >= (Number(h.errors.maxRetries) || 3)) {
          try { if (h.errors.label) await apply(t.id, { add: [h.errors.label] }); } catch { /* ignore */ }
          state.processed[t.id] = { h: t.historyId, m: lastMsgId };
          detail += ` — gave up after ${n} attempts`;
        }
        record({ ...item, action: 'error', detail });
      } finally {
        await onCheckpoint(run);
      }
    }
    pageToken = page?.nextPageToken;
    if (!pageToken) break;
  }

  run.finishedAt = now();
  return run;
}
