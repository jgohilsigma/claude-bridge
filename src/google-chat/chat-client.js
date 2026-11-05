// Client for the Apps Script web app that fronts Google Chat. All traffic is outbound HTTPS from
// this PC (no inbound ports). Requests and responses are HMAC-signed envelopes; see
// src/security/authentication.js.
import { signEnvelope, verifyEnvelope, createNonceCache } from '../security/authentication.js';

export class AppsScriptError extends Error {
  constructor(message, { retryable = true, status } = {}) {
    super(message);
    this.retryable = retryable;
    this.status = status;
  }
}

export class AppsScriptClient {
  constructor({ url, secret, logger, fetchImpl = globalThis.fetch }) {
    this.url = url;
    this.secret = secret;
    this.log = logger;
    this.fetch = fetchImpl;
    this.seenNonce = createNonceCache();
  }

  get configured() {
    return !!(this.url && this.secret);
  }

  async call(op, payload = {}, { timeoutMs = 30000 } = {}) {
    if (!this.configured) throw new AppsScriptError('Apps Script URL or shared secret not configured', { retryable: false });
    const body = JSON.stringify(signEnvelope(this.secret, op, payload));
    let res;
    try {
      // Apps Script answers POST /exec with a 302 to script.googleusercontent.com; fetch follows it
      // (as a GET, per the Fetch spec) and returns doPost()'s output.
      res = await this.fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new AppsScriptError(`network error calling ${op}: ${err.cause?.code || err.name}: ${err.message}`);
    }
    const text = await res.text();
    if ((res.status === 401 || res.status === 403) && /<html/i.test(text)) {
      throw new AppsScriptError(
        `Apps Script web app requires a Google sign-in (HTTP ${res.status}). Redeploy it with "Execute as: Me" and "Who has access: Anyone" ` +
          '(Deploy → Manage deployments → Edit). If "Anyone" is not offered, your Workspace admin restricts it — see README §9.',
        { retryable: false, status: res.status },
      );
    }
    if (!res.ok) {
      throw new AppsScriptError(`Apps Script HTTP ${res.status} for ${op}: ${text.slice(0, 200)}`, { retryable: res.status >= 500 || res.status === 429, status: res.status });
    }
    let env;
    try {
      env = JSON.parse(text);
    } catch {
      // A sign-in page instead of JSON means the web app isn't deployed with "Anyone" access.
      const hint = /<html|accounts\.google\.com/i.test(text) ? ' (got an HTML page: check the web app deployment access is "Anyone")' : '';
      throw new AppsScriptError(`Apps Script returned non-JSON for ${op}${hint}`, { retryable: false });
    }
    if (env && env.error && !env.sig) throw new AppsScriptError(`Apps Script rejected ${op}: ${env.error}`, { retryable: false });
    const v = verifyEnvelope(this.secret, env, { seenNonce: this.seenNonce });
    if (!v.ok) throw new AppsScriptError(`invalid response signature for ${op}: ${v.error}`, { retryable: false });
    if (v.op !== `resp:${op}`) throw new AppsScriptError(`response op mismatch: ${v.op}`, { retryable: false });
    if (v.payload?.error) throw new AppsScriptError(`Apps Script error in ${op}: ${v.payload.error}`, { retryable: !!v.payload.retryable });
    return v.payload;
  }
}
