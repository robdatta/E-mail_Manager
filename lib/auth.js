// OAuth 2.0 for Gmail via chrome.identity.launchWebAuthFlow.
// launchWebAuthFlow (rather than getAuthToken) lets the user pick ANY Google
// account as the target inbox, not only the one signed in to Chrome.
import { OAUTH_CLIENT_ID, SCOPES } from './config.js';

const TOKEN_KEY = 'authTokens'; // { [email]: {token, email, expiresAt} }
const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

export class AuthError extends Error {
  constructor(message, { needsReconnect = false } = {}) {
    super(message);
    this.name = 'AuthError';
    this.needsReconnect = needsReconnect;
  }
}

function authUrl({ interactive, email }) {
  const p = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    response_type: 'token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: SCOPES.join(' '),
    include_granted_scopes: 'true',
    prompt: interactive ? 'select_account consent' : 'none',
  });
  if (email) p.set('login_hint', email);
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}

async function requestToken({ interactive, email }) {
  if (OAUTH_CLIENT_ID.startsWith('REPLACE_')) {
    throw new AuthError('This build has no OAuth client ID yet. The publisher must set it in lib/config.js (see docs/PUBLISHING.md).');
  }
  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({
      url: authUrl({ interactive, email }),
      interactive,
      abortOnLoadForNonInteractive: false,
      timeoutMsForNonInteractive: 15000,
    });
  } catch (e) {
    throw new AuthError(
      interactive
        ? 'Google sign-in was cancelled or failed: ' + e.message
        : 'Your Google sign-in has expired. Open E-Mail Manager and click "Reconnect".',
      { needsReconnect: !interactive },
    );
  }
  const frag = new URLSearchParams(new URL(redirect).hash.slice(1));
  if (frag.get('error')) {
    throw new AuthError('Google sign-in error: ' + frag.get('error'), { needsReconnect: true });
  }
  const token = frag.get('access_token');
  const expiresIn = Number(frag.get('expires_in')) || 3600;
  if (!token) throw new AuthError('Google did not return an access token.', { needsReconnect: true });

  const prof = await fetch(PROFILE_URL, { headers: { Authorization: 'Bearer ' + token } });
  if (!prof.ok) throw new AuthError('Could not read the Gmail profile (HTTP ' + prof.status + ').');
  const { emailAddress } = await prof.json();
  if (email && emailAddress.toLowerCase() !== email.toLowerCase()) {
    throw new AuthError(`You signed in as ${emailAddress}, but the target inbox is ${email}. Sign in with the target account, or change the target inbox.`);
  }
  const record = { token, email: emailAddress, expiresAt: Date.now() + expiresIn * 1000 };
  const { [TOKEN_KEY]: all = {} } = await chrome.storage.session.get(TOKEN_KEY);
  all[emailAddress.toLowerCase()] = record;
  await chrome.storage.session.set({ [TOKEN_KEY]: all });
  return record;
}

/** Returns a valid access token for `email`, refreshing silently when possible. */
export async function getToken(email, { force = false } = {}) {
  if (!force) {
    const { [TOKEN_KEY]: all = {} } = await chrome.storage.session.get(TOKEN_KEY);
    const rec = all[(email || '').toLowerCase()];
    if (rec && rec.token && rec.expiresAt > Date.now() + 120000) return rec.token;
  }
  return (await requestToken({ interactive: false, email })).token;
}

/** Interactive sign-in from the setup page. Returns the confirmed address. */
export async function connect(email) {
  const rec = await requestToken({ interactive: true, email });
  return rec.email;
}

export async function disconnect(email) {
  const { [TOKEN_KEY]: all = {} } = await chrome.storage.session.get(TOKEN_KEY);
  const keys = email ? [email.toLowerCase()] : Object.keys(all);
  for (const k of keys) {
    const rec = all[k];
    delete all[k];
    if (rec?.token) {
      try {
        await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(rec.token), { method: 'POST' });
      } catch { /* best effort */ }
    }
  }
  await chrome.storage.session.set({ [TOKEN_KEY]: all });
}
