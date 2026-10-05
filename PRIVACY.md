# E-Mail Manager — Privacy Policy

_Last updated: October 1, 2026_

E-Mail Manager ("the extension") is published by Rob Datta (robdatta@gmail.com). Utility that scans inbox(es) and replies to messages with text, images, and attachments based on user-specified rules and schedule. This policy explains what data the extension uses and why.

## What the extension accesses

When you connect a Google account, the extension asks Google for the `https://www.googleapis.com/auth/gmail.modify` permission. It uses it to:

- **read** messages in the folder you choose, to check them against your rules;
- **send** the reply you wrote, with the attachments you chose;
- **add or remove labels**, and mark messages read or archive them, as you configured;
- **send you an activity report** e-mail at the inbox that was processed;
- **read your Gmail signature**, if you ask for it to be added to replies.

The extension never deletes e-mail.

## Where your data is kept

- Your settings (rules, reply text, schedule), attachment files, the list of e-mails already handled, and run history are stored **only in your browser**, using Chrome extension storage and IndexedDB.
- Google sign-in tokens are kept in Chrome's session storage and are cleared when Chrome closes.
- E-mail content is read directly from Google's Gmail API into your browser. It is used only to apply your rules and is **not sent to the publisher or to any third party**.
- The extension has no servers. It contacts only Google: `accounts.google.com`, `oauth2.googleapis.com` and `gmail.googleapis.com`.

## Sharing and use

- We do not sell, rent or share your data.
- We do not use your data for advertising, credit decisions or any purpose other than the features described above.
- We do not let humans read your data. The one exception is when you ask us for support and send us information yourself.

E-Mail Manager's use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Your choices

- **Disconnect**: Settings → Review & save → Advanced → *Disconnect Google account*. You can also remove access at <https://myaccount.google.com/permissions>.
- **Delete data**: removing the extension from Chrome deletes all data it stored.

## Contact

Rob Datta — robdatta@gmail.com
