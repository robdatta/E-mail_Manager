// ---------------------------------------------------------------------------
// Publisher settings. Set OAUTH_CLIENT_ID once before uploading to the
// Chrome Web Store (see docs/PUBLISHING.md, step 3). End users never edit this.
// ---------------------------------------------------------------------------
export const OAUTH_CLIENT_ID = 'REPLACE_WITH_YOUR_CLIENT_ID.apps.googleusercontent.com';

// gmail.modify = read messages, send replies, add/remove labels. No delete.
export const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

// Gmail consumer accounts may send ~500 messages/day; keep the ceiling below it.
export const MAX_DAILY_CAP = 400;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // keeps the encoded message under Gmail's 25 MB limit
