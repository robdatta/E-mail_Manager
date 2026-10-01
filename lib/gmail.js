// Thin Gmail REST API client (https://developers.google.com/gmail/api/reference/rest).

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';

export class GmailError extends Error {
  constructor(status, body) {
    let msg = body;
    try { msg = JSON.parse(body).error.message; } catch { /* keep raw */ }
    super(`Gmail API ${status}: ${msg}`);
    this.name = 'GmailError';
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Gmail {
  /** @param {(opts?:{force?:boolean})=>Promise<string>} tokenProvider */
  constructor(tokenProvider, fetchImpl = (...a) => fetch(...a)) {
    this.tokenProvider = tokenProvider;
    this.fetch = fetchImpl;
  }

  async request(url, { method = 'GET', json, body, headers = {} } = {}) {
    let forced = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokenProvider({ force: forced });
      const h = { Authorization: 'Bearer ' + token, ...headers };
      if (json !== undefined) h['Content-Type'] = 'application/json';
      // A hung request must never stall a run: abort after 90 s and retry.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 90000);
      let res;
      try {
        res = await this.fetch(url, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : body, signal: ctrl.signal });
      } catch (e) {
        clearTimeout(timer);
        if (attempt < 4) { await sleep(2000 * 2 ** attempt); continue; }
        throw new Error(`Network problem talking to Gmail (${e.name === 'AbortError' ? 'timed out' : e.message})`);
      }
      clearTimeout(timer);
      if (res.status === 401 && !forced) { forced = true; continue; }
      if ((res.status === 429 || res.status >= 500 ||
           (res.status === 403 && /rate|quota/i.test(await res.clone().text()))) && attempt < 4) {
        await sleep(1000 * 2 ** attempt + Math.random() * 400);
        continue;
      }
      if (!res.ok) throw new GmailError(res.status, await res.text());
      if (res.status === 204) return null;
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
  }

  profile() { return this.request(`${API}/profile`); }

  listThreads({ q, pageToken, maxResults = 50, labelIds }) {
    const p = new URLSearchParams({ maxResults: String(maxResults) });
    if (q) p.set('q', q);
    if (pageToken) p.set('pageToken', pageToken);
    for (const l of labelIds || []) p.append('labelIds', l);
    return this.request(`${API}/threads?${p}`);
  }

  getThread(id) { return this.request(`${API}/threads/${encodeURIComponent(id)}?format=full`); }

  modifyThread(id, addLabelIds = [], removeLabelIds = []) {
    if (!addLabelIds.length && !removeLabelIds.length) return Promise.resolve(null);
    return this.request(`${API}/threads/${encodeURIComponent(id)}/modify`, {
      method: 'POST', json: { addLabelIds, removeLabelIds },
    });
  }

  listLabels() { return this.request(`${API}/labels`); }

  createLabel(name) {
    return this.request(`${API}/labels`, {
      method: 'POST',
      json: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    });
  }

  listSendAs() { return this.request(`${API}/settings/sendAs`); }

  /** Sends a raw RFC 822 message (ASCII string) into an existing thread. */
  sendRaw(mime, threadId) {
    const boundary = 'emgr_' + Math.random().toString(36).slice(2);
    const meta = JSON.stringify(threadId ? { threadId } : {});
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
      `--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n${mime}\r\n--${boundary}--`;
    return this.request(`${UPLOAD}/messages/send?uploadType=multipart`, {
      method: 'POST', body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    });
  }
}

/** Finds a label by (case-insensitive) name, creating it — and its parents — if missing. */
export class LabelResolver {
  constructor(gmail, { dryRun = false } = {}) {
    this.gmail = gmail;
    this.dryRun = dryRun;
    this.byName = null;
  }
  async load() {
    if (this.byName) return;
    const { labels = [] } = (await this.gmail.listLabels()) || {};
    this.byName = new Map(labels.map((l) => [l.name.toLowerCase(), l.id]));
  }
  async id(name) {
    name = (name || '').trim().replace(/\s*\/\s*/g, '/');
    if (!name) return null;
    await this.load();
    const key = name.toLowerCase();
    if (this.byName.has(key)) return this.byName.get(key);
    if (this.dryRun) return `(new label: ${name})`;
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {           // Gmail needs parents to exist for nesting
      const parent = parts.slice(0, i).join('/');
      if (!this.byName.has(parent.toLowerCase())) {
        const created = await this.gmail.createLabel(parent);
        this.byName.set(parent.toLowerCase(), created.id);
      }
    }
    const created = await this.gmail.createLabel(name);
    this.byName.set(key, created.id);
    return created.id;
  }
}
