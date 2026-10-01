// Activity report: spreadsheet + e-mail to the inbox that was processed.
import { buildXlsx, XLSX_MIME } from './xlsx.js';
import { buildMessage, escapeHtml } from './mime.js';

const ACTION_LABEL = {
  replied: 'Replied', 'would-reply': 'Would reply (preview)', labeled: 'Labeled', left: 'Left for review',
  skipped: 'Skipped (already replied)', duplicate: 'Duplicate', deferred: 'Deferred (daily limit)', error: 'Error',
};

const fmt = (t) => (t ? new Date(t).toLocaleString() : '');

export function reportSheets(run) {
  const c = run.counts || {};
  const summary = [
    ['Item', 'Value'],
    ['Inbox', run.account || ''],
    ['Run type', run.dryRun ? 'Preview (nothing sent)' : ({ schedule: 'Scheduled', manual: 'Run now', preview: 'Preview' }[run.trigger] || run.trigger || '')],
    ['Started', fmt(run.startedAt)],
    ['Finished', fmt(run.finishedAt)],
    ['Resumed after interruption', run.resumes ? `${run.resumes} time(s)` : 'No'],
    ['E-mails checked', c.evaluated ?? 0],
    [run.dryRun ? 'Would reply' : 'Replied', c.replied ?? 0],
    ['Labeled', c.labeled ?? 0],
    ['Left for review', c.left ?? 0],
    ['Duplicates', c.duplicates ?? 0],
    ['Skipped (already replied)', c.skipped ?? 0],
    ['Errors', c.errors ?? 0],
    ['Note', run.error || run.stoppedReason || ''],
  ];
  const activity = [
    ['Received', 'Result', 'Subject', 'From', 'Replied to', 'Rule', 'Details', 'Open in Gmail'],
    ...(run.items || []).map((i) => [
      fmt(i.at), ACTION_LABEL[i.action] || i.action, i.subject || '', i.from || '', i.to || '', i.rule || '', i.detail || '',
      i.threadId ? `https://mail.google.com/mail/u/${encodeURIComponent(run.account || '0')}/#all/${i.threadId}` : '',
    ]),
  ];
  return [
    { name: 'Summary', rows: summary, widths: [30, 50] },
    { name: 'Activity', rows: activity, widths: [20, 22, 50, 30, 30, 30, 50, 40] },
  ];
}

export function reportFileName(run) {
  const d = new Date(run.startedAt || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `E-Mail Manager report ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}.xlsx`;
}

export function reportBytes(run) {
  return buildXlsx(reportSheets(run));
}

/** Builds the report e-mail sent to the processed inbox itself. */
export function reportEmail(run) {
  const c = run.counts || {};
  const rows = [
    [run.dryRun ? 'Would reply' : 'Replied', c.replied ?? 0], ['Labeled', c.labeled ?? 0],
    ['Left for review', (c.left ?? 0) + (c.duplicates ?? 0)], ['Skipped', c.skipped ?? 0], ['Errors', c.errors ?? 0],
  ];
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px">
<p>Here is the activity report for <b>${escapeHtml(run.account)}</b> (run started ${escapeHtml(fmt(run.startedAt))}).</p>
<table cellpadding="6" style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="border-bottom:1px solid #ddd">${k}</td><td style="border-bottom:1px solid #ddd;text-align:right"><b>${v}</b></td></tr>`).join('')}</table>
${run.error || run.stoppedReason ? `<p>Note: ${escapeHtml(run.error || run.stoppedReason)}</p>` : ''}
<p>The attached spreadsheet lists every e-mail that was checked.</p>
<p style="color:#777;font-size:12px">Sent by the E-Mail Manager Chrome extension.</p></div>`;
  return buildMessage({
    from: run.account,
    to: [run.account],
    subject: `E-Mail Manager report — ${c.replied ?? 0} ${run.dryRun ? 'would be ' : ''}replied, ${c.evaluated ?? 0} checked`,
    html,
    attachments: [{ name: reportFileName(run), type: XLSX_MIME, bytes: reportBytes(run) }],
  });
}
