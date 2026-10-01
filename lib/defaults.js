// Default settings and starter templates.

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function newRule(partial = {}) {
  return {
    id: uid(),
    enabled: true,
    name: 'New rule',
    include: '',          // keywords, one per line or comma-separated; /regex/ allowed
    exclude: '',
    matchMode: 'any',     // 'any' | 'all' include keywords must appear
    fields: { subject: true, body: false, sender: false },
    action: 'reply',      // 'reply' | 'label' | 'leave'
    label: '',            // for 'label' and optional for 'leave'
    archive: true,        // for 'label': remove from the scanned folder
    markRead: false,      // for 'label'
    ...partial,
  };
}

export function defaultConfig() {
  return {
    version: 1,
    configured: false,
    account: { email: '' },
    scope: {
      label: 'INBOX',          // Gmail label id to scan
      labelName: 'Inbox',
      unreadOnly: true,
      after: '',               // YYYY-MM-DD, optional
      extraQuery: '',          // any extra Gmail search terms
      skipAlreadyReplied: true,
    },
    rules: [],
    reply: {
      subjectTemplate: 'Re: {{subject}}',
      html: '<div>Hello,</div><div><br></div><div>Thank you for reaching out.</div>',
      text: 'Hello,\n\nThank you for reaching out.',
      appendSignature: true,
      replyAll: false,
    },
    attachments: [],            // [{id, name, type, size}] — file bytes live in IndexedDB
    handling: {
      afterSend: { label: 'Replied', archive: true, markRead: true },
      unmatched: { action: 'leave', label: '' },          // 'leave' | 'label'
      duplicates: { policy: 'newest', action: 'leave', label: '' }, // policy 'newest' | 'all'
      relay: {
        domains: 'dice.com\nziprecruiter.com\nlinkedin.com',
        noAddress: 'leave',                             // 'leave' | 'replyRelay'
      },
      errors: { maxRetries: 3, label: 'E-Mail Manager/Errors' },
    },
    report: {
      emailAfterRun: true,       // e-mail the activity spreadsheet to the processed inbox
      onlyWhenActivity: true,    // …but not for runs where nothing happened
      includePreviews: false,    // …and not for previews unless asked
    },
    schedule: {
      mode: 'off',              // 'off' | 'interval' | 'daily'
      everyMinutes: 60,
      dailyTime: '08:00',
      weekdaysOnly: false,
      batchSize: 25,
      dailyCap: 100,
      notify: true,
    },
  };
}

// Starter rules modeled on a job-seeker workflow. Users can edit or delete them.
export function recruiterTemplate() {
  return [
    newRule({
      name: 'Hold for manual review (borderline roles)',
      include: 'AI Business Analyst\nSales Manager\nAccounting Manager\nBudget Manager\nSourcing Manager',
      fields: { subject: true, body: false, sender: false },
      action: 'leave',
    }),
    newRule({
      name: 'Reply: project / program / product / leadership / AI roles',
      include: [
        'Project Manager', 'Program Manager', 'Product Manager', 'Product Owner',
        'Project Management', 'Program Director', 'Director', 'Delivery Lead',
        'Delivery Manager', 'Release Manager', 'Engagement Manager', 'Scrum Master',
        'AI', 'Artificial Intelligence', 'Machine Learning', 'ML Engineer', 'GenAI', 'Gen AI',
      ].join('\n'),
      exclude: 'Business Analyst\nDeveloper\nTester',
      fields: { subject: true, body: false, sender: false },
      action: 'reply',
    }),
    newRule({
      name: 'Other job offers → Review Later',
      include: 'job\nposition\nrole\nhiring\nopening\nopportunity\ncontract\nW2\nC2C\nrequirement',
      fields: { subject: true, body: false, sender: false },
      action: 'label',
      label: 'Career/Review Later',
      archive: true,
      markRead: false,
    }),
  ];
}

export const PLACEHOLDERS = [
  ['{{sender_name}}', 'Sender full name'],
  ['{{sender_first_name}}', 'Sender first name'],
  ['{{subject}}', 'Original subject'],
  ['{{my_email}}', 'Your e-mail address'],
];
