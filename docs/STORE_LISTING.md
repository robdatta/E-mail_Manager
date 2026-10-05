# Chrome Web Store listing

**Name:** E-Mail Manager

**Summary (132 characters max):**
Utility that scans inbox(es) and replies to messages with text, images, and attachments based on user-specified rules and schedule.

**Category:** Productivity

**Description:**

Utility that scans inbox(es) and replies to messages with text, images, and attachments based on user-specified rules and schedule.

Set it up once in a short guided wizard:

• Inbox. Choose any Gmail or Google Workspace inbox. Click the toolbar button while Gmail is open and it uses that inbox, or pick another.
• Rules. Decide which e-mails get your reply, which only get a label, and which wait for you, using simple keywords (regular expressions are also supported).
• Reply. Write your message in a rich text editor. Add the sender's name, the original subject and your Gmail signature.
• Attachments. Attach your résumé, price list or any other files to every reply.
• After sending. Add a label, archive, mark as read. Choose how to handle duplicates and job-board senders, which get a reply sent to the real recruiter address.
• Schedule. Run every few minutes or hours, once a day, or only when you click Run now. Choose how many e-mails each run checks and the most replies per day.
• Report. After each run, a spreadsheet (.xlsx) of everything that was done is e-mailed to your inbox. You can also download it.

Safe by design:
• Preview shows exactly what would happen without sending anything.
• It never deletes e-mail and never answers the same conversation twice.
• If Chrome closes or freezes during a run, the run continues where it stopped.
• Everything runs inside your browser. Your e-mail is read only by the extension, through Google's official Gmail API, and is never sent to anyone else.

Made by Rob Datta. Source code: https://github.com/robdatta/E-mail_Manager

---

## Privacy practices tab

**Single purpose:**
Utility that scans inbox(es) and replies to messages with text, images, and attachments based on user-specified rules and schedule.

**Permission justifications:**
- `identity`: Signs the user in to the Google account whose inbox they choose, using Google OAuth.
- `storage`, `unlimitedStorage`: Saves the user's settings, run history and the attachment files they choose, locally in the browser.
- `alarms`: Runs on the schedule the user sets, and resumes an interrupted run.
- `notifications`: Tells the user when a scheduled run finishes or needs attention.
- `activeTab`: When the user clicks the toolbar button on a Gmail tab, reads that tab's title to suggest the inbox shown in it.
- Host permissions: `gmail.googleapis.com` is the Gmail API, used to read messages, send replies and apply labels. `oauth2.googleapis.com` is used to revoke access when the user disconnects.

**Remote code:** No. All code is included in the package.

**Data usage:** Personally identifiable information (the e-mail address) and personal communications (e-mail content). They are used only for the extension's single purpose, never sold or transferred, and never used for credit decisions.
