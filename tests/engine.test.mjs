import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEngine, buildQuery, findRelayContact, normalizeSubject } from '../lib/engine.js';
import { defaultConfig, recruiterTemplate } from '../lib/defaults.js';
import { compileRule, ruleMatches } from '../lib/rules.js';
import { buildMessage, summarize, encodeHeader } from '../lib/mime.js';

const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url');

function msg({ id, thread, from, subject, body, labels = ['INBOX', 'UNREAD'], replyTo, html }) {
  const headers = [
    { name: 'From', value: from },
    { name: 'To', value: 'me@example.com' },
    { name: 'Subject', value: subject },
    { name: 'Message-ID', value: `<${id}@mail>` },
  ];
  if (replyTo) headers.push({ name: 'Reply-To', value: replyTo });
  const payload = html
    ? { mimeType: 'multipart/alternative', headers, parts: [{ mimeType: 'text/html', body: { data: b64u(html) } }] }
    : { mimeType: 'text/plain', headers, body: { data: b64u(body || '') } };
  return { id, threadId: thread, labelIds: labels, internalDate: '1', payload };
}

class FakeGmail {
  constructor(threads) {
    this.threads = threads; // [{id, historyId, messages}]
    this.sent = [];
    this.modified = [];
    this.labels = [{ id: 'INBOX', name: 'INBOX' }, { id: 'UNREAD', name: 'UNREAD' }];
    this.created = [];
  }
  async listThreads() { return { threads: this.threads.map((t) => ({ id: t.id, historyId: t.historyId })) }; }
  async getThread(id) { return this.threads.find((t) => t.id === id); }
  async modifyThread(id, add, remove) { this.modified.push({ id, add, remove }); }
  async listLabels() { return { labels: this.labels }; }
  async createLabel(name) { const l = { id: 'L_' + name, name }; this.labels.push(l); this.created.push(name); return l; }
  async sendRaw(mime, threadId) { this.sent.push({ mime, threadId }); return { id: 's' + this.sent.length }; }
}

function config() {
  const c = defaultConfig();
  c.configured = true;
  c.account.email = 'me@example.com';
  c.rules = recruiterTemplate();
  c.reply.html = '<p>Hello {{sender_first_name}},</p><p>Thanks!</p>';
  c.reply.text = 'Hello {{sender_first_name}},\n\nThanks!';
  c.handling.afterSend = { label: 'Career', archive: true, markRead: true };
  c.attachments = [{ id: 'a1', name: 'Resume.pdf', type: 'application/pdf', size: 3 }];
  return c;
}

const freshState = () => ({ processed: {}, failures: {}, repliedKeys: {}, sentLog: [] });
const files = async () => [{ name: 'Resume.pdf', type: 'application/pdf', bytes: new Uint8Array([37, 80, 68]) }];

test('replies to matching role with attachment, labels and archives', async () => {
  const g = new FakeGmail([{ id: 't1', historyId: '1', messages: [msg({ id: 'm1', thread: 't1', from: 'Jane Roe <jane@acme.com>', subject: 'Senior Project Manager - Remote' })] }]);
  const state = freshState();
  const run = await runEngine({ config: config(), gmail: g, state, loadAttachments: files });
  assert.equal(run.counts.replied, 1);
  assert.equal(g.sent.length, 1);
  assert.equal(g.sent[0].threadId, 't1');
  const mime = g.sent[0].mime;
  assert.match(mime, /^From: me@example.com/m);
  assert.match(mime, /^To: jane@acme.com/m);
  assert.match(mime, /^Subject: Re: Senior Project Manager - Remote/m);
  assert.match(mime, /^In-Reply-To: <m1@mail>/m);
  assert.match(mime, /filename="Resume.pdf"/);
  assert.ok(Buffer.from(mime.split('text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0].replace(/\r\n/g, ''), 'base64').toString().includes('Hello Jane'));
  assert.deepEqual(g.created, ['Career']);
  assert.deepEqual(g.modified[0], { id: 't1', add: ['L_Career'], remove: ['INBOX', 'UNREAD'] });
  assert.equal(state.processed.t1.m, 'm1');
});

test('other job offers get Review Later label and stay unread; non-jobs untouched', async () => {
  const g = new FakeGmail([
    { id: 't1', historyId: '1', messages: [msg({ id: 'm1', thread: 't1', from: 'a@x.com', subject: 'Java Developer contract role' })] },
    { id: 't2', historyId: '1', messages: [msg({ id: 'm2', thread: 't2', from: 'shop@store.com', subject: 'Your order shipped' })] },
    { id: 't3', historyId: '1', messages: [msg({ id: 'm3', thread: 't3', from: 'b@y.com', subject: 'Urgent: Sales Manager opening' })] },
  ]);
  const run = await runEngine({ config: config(), gmail: g, state: freshState(), loadAttachments: files });
  assert.equal(g.sent.length, 0);
  assert.equal(run.counts.labeled, 1);
  assert.equal(run.counts.left, 2);
  assert.deepEqual(g.modified, [{ id: 't1', add: ['L_Career/Review Later'], remove: ['INBOX'] }]);
  assert.deepEqual(g.created, ['Career', 'Career/Review Later']); // parent created first
});

test('"AI" keyword does not match inside words like "email" or "maintain"', () => {
  const r = compileRule({ ...recruiterTemplate()[1] });
  assert.equal(ruleMatches(r, { subject: 'Email Maintenance Specialist' }), null);
  assert.ok(ruleMatches(r, { subject: 'AI Engineer - Remote' }));
  assert.ok(ruleMatches(r, { subject: 'Sr. Product Owner (GenAI)' }));
});

test('relay sender: replies to recruiter address found in the body', async () => {
  const body = 'Hi Rob, role: Program Manager. Thanks, Nikhil  E:nikhil.ranjan@peopleintegra.com unsubscribe@dice.com';
  const g = new FakeGmail([{ id: 't1', historyId: '1', messages: [msg({ id: 'm1', thread: 't1', from: 'abc@user.dice.com', subject: 'Program Manager || Remote', body })] }]);
  await runEngine({ config: config(), gmail: g, state: freshState(), loadAttachments: files });
  assert.match(g.sent[0].mime, /^To: nikhil.ranjan@peopleintegra.com/m);
});

test('relay sender with no address is left alone by default', async () => {
  const g = new FakeGmail([{ id: 't1', historyId: '1', messages: [msg({ id: 'm1', thread: 't1', from: 'abc@user.dice.com', subject: 'Program Manager', body: 'no address here' })] }]);
  const run = await runEngine({ config: config(), gmail: g, state: freshState(), loadAttachments: files });
  assert.equal(g.sent.length, 0);
  assert.equal(run.counts.left, 1);
});

test('already-replied threads are skipped', async () => {
  const g = new FakeGmail([{ id: 't1', historyId: '1', messages: [
    msg({ id: 'm1', thread: 't1', from: 'x@acme.com', subject: 'Project Manager' }),
    msg({ id: 'm2', thread: 't1', from: 'me@example.com', subject: 'Re: Project Manager', labels: ['SENT'] }),
    msg({ id: 'm3', thread: 't1', from: 'x@acme.com', subject: 'Re: Project Manager' }),
  ] }]);
  const run = await runEngine({ config: config(), gmail: g, state: freshState(), loadAttachments: files });
  assert.equal(run.counts.skipped, 1);
  assert.equal(g.sent.length, 0);
});

test('duplicates: newest answered, older left', async () => {
  const g = new FakeGmail([
    { id: 'new', historyId: '1', messages: [msg({ id: 'm1', thread: 'new', from: 'a@acme.com', subject: 'Project Manager - Tampa' })] },
    { id: 'old', historyId: '1', messages: [msg({ id: 'm2', thread: 'old', from: 'b@acme.com', subject: 'RE: Project Manager – Tampa' })] },
  ]);
  const run = await runEngine({ config: config(), gmail: g, state: freshState(), loadAttachments: files });
  assert.equal(g.sent.length, 1);
  assert.equal(run.counts.duplicates, 1);
});

test('dry run sends nothing and changes nothing', async () => {
  const g = new FakeGmail([{ id: 't1', historyId: '1', messages: [msg({ id: 'm1', thread: 't1', from: 'j@acme.com', subject: 'Product Manager' })] }]);
  const state = freshState();
  const run = await runEngine({ config: config(), gmail: g, state, loadAttachments: files, dryRun: true });
  assert.equal(run.counts.replied, 1);
  assert.equal(run.items[0].action, 'would-reply');
  assert.equal(g.sent.length + g.modified.length + g.created.length, 0);
  assert.deepEqual(state.processed, {});
});

test('batch size and daily cap are respected; processed threads are not re-evaluated', async () => {
  const threads = Array.from({ length: 5 }, (_, i) => ({ id: 't' + i, historyId: '1', messages: [msg({ id: 'm' + i, thread: 't' + i, from: `r${i}@co${i}.com`, subject: `Program Manager ${i}` })] }));
  const c = config();
  c.schedule.batchSize = 3;
  const state = freshState();
  const g = new FakeGmail(threads);
  const r1 = await runEngine({ config: c, gmail: g, state, loadAttachments: files });
  assert.equal(r1.counts.evaluated, 3);
  // label changes alter historyId; same last message → not counted again
  threads.slice(0, 3).forEach((t) => { t.historyId = '2'; });
  c.schedule.dailyCap = 4;
  const r2 = await runEngine({ config: c, gmail: g, state, loadAttachments: files });
  assert.equal(r2.counts.evaluated, 2);
  assert.equal(g.sent.length, 4);
  assert.match(r2.stoppedReason, /Daily send limit/);
});

test('send failure is retried, then labeled after max retries', async () => {
  const g = new FakeGmail([{ id: 't1', historyId: '1', messages: [msg({ id: 'm1', thread: 't1', from: 'j@acme.com', subject: 'Product Manager' })] }]);
  g.sendRaw = async () => { throw new Error('boom'); };
  const c = config();
  c.handling.errors.maxRetries = 2;
  const state = freshState();
  await runEngine({ config: c, gmail: g, state, loadAttachments: files });
  assert.equal(state.failures.t1, 1);
  assert.equal(state.processed.t1, undefined);
  const r = await runEngine({ config: c, gmail: g, state, loadAttachments: files });
  assert.match(r.items[0].detail, /gave up after 2/);
  assert.ok(state.processed.t1);
  assert.ok(g.created.includes('E-Mail Manager/Errors'));
});

test('helpers', () => {
  assert.equal(buildQuery({ unreadOnly: true, after: '2024-10-01', extraQuery: '' }), 'is:unread after:2024/10/01 -in:chats');
  assert.equal(normalizeSubject('Re: FW: Project  Manager!!'), 'project manager');
  assert.equal(findRelayContact('x noreply@dice.com Jane jane.doe@corp.com', { relayDomains: ['dice.com'], me: 'me@x.com' }), 'jane.doe@corp.com');
  assert.match(encodeHeader('Re: Café — rôle'), /^=\?UTF-8\?B\?/);
  const m = buildMessage({ to: ['a@b.com'], subject: 'Hi', html: '<b>x</b>', attachments: [] });
  assert.match(m, /multipart\/alternative/);
  const s = summarize(msg({ id: 'x', thread: 't', from: '"Doe, Jane" <JANE@Acme.com>', subject: 's', html: '<p>Hi<br>there</p>' }));
  assert.equal(s.fromEmail, 'jane@acme.com');
  assert.equal(s.fromName, 'Doe, Jane');
  assert.equal(s.body, 'Hi\nthere');
});

test('resume: an interrupted run continues and keeps earlier results', async () => {
  const threads = Array.from({ length: 4 }, (_, i) => ({ id: 't' + i, historyId: '1', messages: [msg({ id: 'm' + i, thread: 't' + i, from: `r${i}@co${i}.com`, subject: `Program Manager ${i}` })] }));
  const c = config();
  c.schedule.batchSize = 4;
  const state = freshState();
  const g = new FakeGmail(threads);
  let checkpoint;
  // Simulate a crash after the second e-mail: the checkpoint callback throws.
  let n = 0;
  await assert.rejects(runEngine({ config: c, gmail: g, state, loadAttachments: files,
    onCheckpoint: async (r) => { checkpoint = structuredClone(r); if (++n === 2) { const e = new Error('crash'); e.name = 'AuthError'; throw e; } } }));
  assert.equal(g.sent.length, 2);
  const run = await runEngine({ config: c, gmail: g, state, loadAttachments: files, resumeFrom: checkpoint });
  assert.equal(g.sent.length, 4, 'no e-mail answered twice, none skipped');
  assert.equal(run.counts.replied, 4);
  assert.equal(run.items.length, 4);
  assert.equal(run.resumes, 1);
});

test('report e-mail goes to the processed inbox with a valid .xlsx', async () => {
  const { reportEmail, reportBytes } = await import('../lib/report.js');
  const run = { account: 'me@example.com', startedAt: 1, finishedAt: 2, counts: { evaluated: 1, replied: 1 }, items: [{ action: 'replied', subject: 'PM', threadId: 't' }] };
  const mime = reportEmail(run);
  assert.match(mime, /^To: me@example.com/m);
  assert.match(mime, /spreadsheetml\.sheet/);
  const bytes = reportBytes(run);
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), 'PK');
});

test('images placed in the reply text are sent inline (multipart/related + Content-ID)', async () => {
  const g = new FakeGmail([{ id: 't1', historyId: '1', messages: [msg({ id: 'm1', thread: 't1', from: 'Jane Roe <jane@acme.com>', subject: 'Program Manager' })] }]);
  const c = config();
  c.reply.html = '<p>Hello {{sender_first_name}}</p><img src="emgr-inline:abc123" alt="logo" width="200">';
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  let asked;
  await runEngine({ config: c, gmail: g, state: freshState(), loadAttachments: files,
    loadInlineImages: async (ids) => { asked = ids; return [{ id: 'abc123', name: 'logo.png', type: 'image/png', bytes: png }]; } });
  assert.deepEqual(asked, ['abc123']);
  const mime = g.sent[0].mime;
  assert.match(mime, /multipart\/mixed/);
  assert.match(mime, /multipart\/related/);
  assert.match(mime, /^Content-ID: <abc123@email-manager>/m);
  assert.match(mime, /^Content-Disposition: inline; filename="logo.png"/m);
  const htmlB64 = mime.split('text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0].replace(/\r\n/g, '');
  const html = Buffer.from(htmlB64, 'base64').toString();
  assert.ok(html.includes('src="cid:abc123@email-manager"'), html);
  assert.ok(!html.includes('emgr-inline'));
  // order: related part (with the image) comes before the Resume.pdf attachment
  assert.ok(mime.indexOf('logo.png') < mime.indexOf('Resume.pdf'));
});
