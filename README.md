# E-Mail Manager

A Chrome extension that answers Gmail messages for you using rules you set. You choose:

1. **Inbox.** Any Gmail or Google Workspace address. If you click the toolbar button while a Gmail inbox is open, it uses that inbox, and you can pick another one.
2. **Rules.** Keyword rules decide which e-mails get a reply, which only get a label, and which are left for you to review.
3. **Reply text.** Written in a rich text editor, with fields such as `{{sender_first_name}}` and your Gmail signature.
4. **Attachments.** The files to add to every reply (up to 20 MB). Nothing from the original e-mail is carried over.
5. **Handling.** What happens after a reply (label, archive, mark read), plus how to treat duplicates, job-board relay senders (Dice, ZipRecruiter, LinkedIn) and errors.
6. **Schedule.** Run every N minutes or daily, set how many e-mails each run checks and the daily send limit, or use **Run now** and **Preview**.
7. **Report.** After each run, a spreadsheet of everything done is e-mailed to the processed inbox. You can also download it from the toolbar button.

If Chrome closes or freezes during a run, the run continues where it stopped the next time Chrome starts. No e-mail is answered twice.

Author: Rob Datta (robdatta@gmail.com)

## How it works

The extension talks to the Gmail API directly (`gmail.googleapis.com`). It does not script the Gmail web page, so it is not affected when the Gmail page is slow. All settings, attachment files and history stay in your browser. Nothing is sent to any server other than Google's.

```
popup.html / popup.js    toolbar dashboard: inbox picker, Run now, Preview, Stop, last run, report
app.html / app.js        7-step setup wizard (also the Options page)
background.js            service worker: schedule, runs, crash-safe resume, report e-mail
lib/engine.js            the rule engine (no Chrome APIs; unit-tested)
lib/rules.js             keyword / regex matching
lib/mime.js              Gmail message parsing and RFC 822 reply building
lib/gmail.js             Gmail REST client with retries and timeouts
lib/auth.js              Google sign-in (chrome.identity.launchWebAuthFlow)
lib/store.js             settings (chrome.storage) and attachment files (IndexedDB)
lib/report.js, xlsx.js   activity report spreadsheet (dependency-free .xlsx writer)
```

## Develop

```bash
npm test                 # unit tests (Node 18+), no install needed
./scripts/package.sh     # builds dist/email-manager-<version>.zip for the Chrome Web Store
```

To load it locally, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose this folder. Google sign-in needs an OAuth client ID first; see [docs/PUBLISHING.md](docs/PUBLISHING.md).

## Publish

See [docs/PUBLISHING.md](docs/PUBLISHING.md) for the Google Cloud, OAuth verification and Chrome Web Store steps. The store listing text is in [docs/STORE_LISTING.md](docs/STORE_LISTING.md) and the privacy policy is in [PRIVACY.md](PRIVACY.md).

## License

MIT. See [LICENSE](LICENSE).
