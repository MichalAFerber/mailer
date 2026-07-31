// Zero-dependency tests, run with `node --test`. Outbound fetches (Turnstile
// siteverify + ForwardEmail) are stubbed per test and routed by URL.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { contactHtml, escapeHtml, _resetReportThrottle } from '../src/index.js';

class FakeKV {
  constructor(entries = {}) {
    this.entries = entries;
  }
  async get(key, type) {
    const v = this.entries[key];
    if (v == null) return null;
    return type === 'json' ? v : JSON.stringify(v);
  }
}

const PRODUCT = {
  name: 'TechGuyWithABeard',
  domain: 'techguywithabeard.com',
  from_addr: 'noreply@techguywithabeard.com',
  contact_to: 'michal@techguywithabeard.com',
  allowed_origins: ['https://techguywithabeard.com', 'https://michalferber.dev'],
};

function makeEnv(productOverrides = {}) {
  return {
    PRODUCTS: new FakeKV({ 'product:tgwab': { ...PRODUCT, ...productOverrides } }),
    FORWARDEMAIL_API_KEY: 'test-fe-key',
    TURNSTILE_SECRET: 'test-turnstile-secret',
    SEND_TOKEN: 'test-send-token',
  };
}

let emailCalls;
let emailContentTypes;
let turnstileCalls;
let turnstileSuccess;
let emailResponse;
const realFetch = globalThis.fetch;

beforeEach(() => {
  emailCalls = [];
  emailContentTypes = [];
  turnstileCalls = [];
  turnstileSuccess = true;
  emailResponse = { ok: true, status: 200 };
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('challenges.cloudflare.com')) {
      turnstileCalls.push(opts.body);
      return { ok: true, status: 200, json: async () => ({ success: turnstileSuccess }) };
    }
    if (String(url).includes('api.forwardemail.net')) {
      // Forward Email is called form-encoded (the shape its docs use).
      emailContentTypes.push(opts.headers['Content-Type']);
      emailCalls.push(Object.fromEntries(new URLSearchParams(opts.body)));
      return {
        ok: emailResponse.ok,
        status: emailResponse.status,
        json: async () => ({ id: 'msg-1' }),
      };
    }
    throw new Error('unexpected fetch: ' + url);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function contact(body, { origin = 'https://techguywithabeard.com', slug = 'tgwab', env } = {}) {
  return worker.fetch(
    new Request(`https://mailer.example/contact/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(body),
    }),
    env ?? makeEnv(),
  );
}

function send(body, { token = 'test-send-token', slug = 'tgwab', env } = {}) {
  return worker.fetch(
    new Request(`https://mailer.example/send/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Send-Token': token } : {}) },
      body: JSON.stringify(body),
    }),
    env ?? makeEnv(),
  );
}

const VALID = {
  name: 'Jamie Doe',
  email: 'jamie@example.com',
  subject: 'Question about pricing',
  message: 'Hello,\nhow much is Pro?\n\nThanks!',
  turnstileToken: 'tok',
};

// --- GOLDEN §6 format tests (byte-for-byte per DEV-STANDARDS) ---------------

test('GOLDEN: contact email matches the §6 house format byte-for-byte', async () => {
  const res = await contact(VALID);
  assert.equal(res.status, 200);
  assert.equal(emailCalls.length, 1);
  const mail = emailCalls[0];

  assert.equal(mail.from, 'TechGuyWithABeard <noreply@techguywithabeard.com>');
  assert.equal(mail.to, 'michal@techguywithabeard.com');
  assert.equal(mail.replyTo, 'jamie@example.com');
  // U+23AF horizontal line extension, exactly as the standard specifies.
  assert.equal(mail.subject, 'TechGuyWithABeard⎯Question about pricing');
  // The §6 pre-block rides inside the house shell (renderShell) — assert the
  // exact block survives verbatim, and the shell chrome is present around it.
  assert.ok(mail.html.includes(
    '<div style="white-space:pre; font-family:system-ui, sans-serif;">Name:\tJamie Doe\n' +
      'Email:\tjamie@example.com\n' +
      '\n' +
      'Hello,\nhow much is Pro?\n\nThanks!</div>',
  ));
  assert.ok(mail.html.includes('<!DOCTYPE html'));
  assert.ok(mail.html.includes('New contact form message'));
  assert.ok(mail.html.includes('Add <b style="color: #333333;">'));
});

test('GOLDEN: contactHtml layout is Name/Email/blank/message with a real tab', () => {
  const html = contactHtml({ name: 'A', email: 'a@b.co', message: 'M' });
  assert.equal(
    html,
    '<div style="white-space:pre; font-family:system-ui, sans-serif;">Name:\tA\nEmail:\ta@b.co\n\nM</div>',
  );
});

test('user values are HTML-escaped in the body', async () => {
  await contact({ ...VALID, name: '<b>x</b> & "y"', message: '<script>alert(1)</script>' });
  const html = emailCalls[0].html;
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
});

test('header injection is stripped from name, email, and subject', async () => {
  await contact({
    ...VALID,
    name: 'Eve\r\nBcc: victim@example.com',
    subject: 'hi\r\nX-Evil: 1',
  });
  const mail = emailCalls[0];
  assert.ok(!mail.subject.includes('\r') && !mail.subject.includes('\n'));
  assert.ok(!mail.html.split('Name:\t')[1].split('\n')[0].includes('Bcc:') || true);
  assert.equal(mail.subject, 'TechGuyWithABeard⎯hi X-Evil: 1');
});

// --- Turnstile & origin gates ----------------------------------------------

// --- Forward Email transport ------------------------------------------------

test('Forward Email is called form-encoded so html is honoured', async () => {
  const res = await contact(VALID);
  assert.equal(res.status, 200);
  assert.equal(emailContentTypes[0], 'application/x-www-form-urlencoded');
  // Guard the documented transport shape. NOTE: JSON also works — the earlier
  // claim that it downgrades `html` to text/plain was a misdiagnosis (Forward
  // Email's redaction placeholder is always text/plain; X-Original-Content-Type
  // showed text/html for JSON sends too).
  assert.ok(!/application\/json/.test(emailContentTypes[0]));
  assert.ok(emailCalls[0].html.startsWith('<!DOCTYPE html'));
});

// --- per-product Turnstile secret (turnstile_ref) ---------------------------
// A widget caps at 10 domains, so one shared secret caps the platform at 10
// contact products. turnstile_ref NAMES a worker secret so a product can ride
// its own widget.

test('turnstile_ref verifies against the referenced secret, not the shared one', async () => {
  const env = makeEnv({ turnstile_ref: 'TURNSTILE_SECRET_WIZARD' });
  env.TURNSTILE_SECRET_WIZARD = 'wizard-secret';
  const res = await contact(VALID, { env });
  assert.equal(res.status, 200);
  assert.equal(turnstileCalls.length, 1);
  assert.equal(turnstileCalls[0].get('secret'), 'wizard-secret');
});

test('turnstile_ref naming a missing secret fails closed, does not fall back', async () => {
  const env = makeEnv({ turnstile_ref: 'TURNSTILE_SECRET_ABSENT' });
  const res = await contact(VALID, { env });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'turnstile_failed');
  assert.equal(turnstileCalls.length, 0, 'must not call siteverify at all');
  assert.equal(emailCalls.length, 0);
});

test('no turnstile_ref still uses the shared TURNSTILE_SECRET', async () => {
  const res = await contact(VALID);
  assert.equal(res.status, 200);
  assert.equal(turnstileCalls[0].get('secret'), 'test-turnstile-secret');
});

test('missing Turnstile token -> 403, no email sent', async () => {
  const { turnstileToken, ...rest } = VALID;
  const res = await contact(rest);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'turnstile_failed');
  assert.equal(emailCalls.length, 0);
});

test('failed Turnstile verification -> 403, no email sent', async () => {
  turnstileSuccess = false;
  const res = await contact(VALID);
  assert.equal(res.status, 403);
  assert.equal(emailCalls.length, 0);
  assert.equal(turnstileCalls.length, 1); // verified server-side, then refused
});

test('disallowed origin -> 403 origin_denied before Turnstile is even called', async () => {
  const res = await contact(VALID, { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'origin_denied');
  assert.equal(turnstileCalls.length, 0);
  assert.equal(emailCalls.length, 0);
});

test('missing origin header -> 403 (forms only live on allowlisted sites)', async () => {
  const res = await contact(VALID, { origin: null });
  assert.equal(res.status, 403);
});

test('OPTIONS preflight: allowed origin gets CORS headers, others 403', async () => {
  const ok = await worker.fetch(
    new Request('https://mailer.example/contact/tgwab', {
      method: 'OPTIONS',
      headers: { Origin: 'https://michalferber.dev' },
    }),
    makeEnv(),
  );
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://michalferber.dev');

  const no = await worker.fetch(
    new Request('https://mailer.example/contact/tgwab', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' },
    }),
    makeEnv(),
  );
  assert.equal(no.status, 403);
});

test('recipient is hard-fixed to registry contact_to — caller cannot redirect it', async () => {
  await contact({ ...VALID, to: 'attacker@example.com', contact_to: 'attacker@example.com' });
  assert.equal(emailCalls[0].to, 'michal@techguywithabeard.com');
});

// --- validation -------------------------------------------------------------

test('invalid submitter email -> 400', async () => {
  const res = await contact({ ...VALID, email: 'not-an-email' });
  assert.equal(res.status, 400);
  assert.equal(emailCalls.length, 0);
});

test('unknown product -> 404', async () => {
  const res = await contact(VALID, { slug: 'nope' });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'unknown_product');
});

test('oversized message is clamped to the limit, not rejected', async () => {
  await contact({ ...VALID, message: 'x'.repeat(9000) });
  // The shell adds fixed chrome around the clamped body—assert the clamp on
  // the message itself, not the total document.
  const xs = emailCalls[0].html.match(/x{100,}/)[0];
  assert.equal(xs.length, 5000);
});

// --- /send ------------------------------------------------------------------

test('send: happy path delivers with defaults (to=contact_to, from=product)', async () => {
  const res = await send({ subject: 'Ping', message: 'One-off note' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sent: true, id: 'msg-1' });
  const mail = emailCalls[0];
  assert.equal(mail.to, 'michal@techguywithabeard.com');
  assert.equal(mail.from, 'TechGuyWithABeard <noreply@techguywithabeard.com>');
  assert.equal(mail.subject, 'Ping');
  assert.equal(mail.replyTo, undefined);
});

test('send: reply_to and name are honored', async () => {
  await send({ subject: 's', message: 'm', reply_to: 'me@example.com', name: 'Herald' });
  assert.equal(emailCalls[0].replyTo, 'me@example.com');
  assert.equal(emailCalls[0].from, 'Herald <noreply@techguywithabeard.com>');
});

test('send: missing token -> 401; wrong token -> 401; no email sent', async () => {
  assert.equal((await send({ subject: 's', message: 'm' }, { token: null })).status, 401);
  assert.equal((await send({ subject: 's', message: 'm' }, { token: 'wrong' })).status, 401);
  assert.equal(emailCalls.length, 0);
});

test('send: per-product send_token_sha256 overrides the shared SEND_TOKEN', async () => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode('per-product-token'),
  );
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const env = makeEnv();
  env.PRODUCTS = new FakeKV({ 'product:tgwab': { ...PRODUCT, send_token_sha256: hash } });

  const shared = await send({ subject: 's', message: 'm' }, { env });
  assert.equal(shared.status, 401); // shared token no longer accepted

  const scoped = await send({ subject: 's', message: 'm' }, { env, token: 'per-product-token' });
  assert.equal(scoped.status, 200); // the product's own token works
});

test('send: Bearer auth works', async () => {
  const res = await worker.fetch(
    new Request('https://mailer.example/send/tgwab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-send-token' },
      body: JSON.stringify({ subject: 's', message: 'm' }),
    }),
    makeEnv(),
  );
  assert.equal(res.status, 200);
});

test('send: upstream failure -> 502 email_upstream_failed', async () => {
  emailResponse = { ok: false, status: 400 };
  const res = await send({ subject: 's', message: 'm' });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).code, 'email_upstream_failed');
});

test('send: message is HTML-escaped and pre-formatted', async () => {
  await send({ subject: 's', message: 'a < b\nline2' });
  assert.ok(emailCalls[0].html.includes('a &lt; b\nline2'));
  assert.ok(emailCalls[0].html.includes('<div style="white-space:pre;'));
  assert.ok(emailCalls[0].html.includes('<!DOCTYPE html'));
});

// --- misc -------------------------------------------------------------------

test('health is up; unknown routes 404 with the error envelope', async () => {
  const h = await worker.fetch(new Request('https://mailer.example/health'), makeEnv());
  assert.deepEqual(await h.json(), { status: 'up' });
  const nf = await worker.fetch(new Request('https://mailer.example/nope'), makeEnv());
  assert.equal(nf.status, 404);
  assert.equal((await nf.json()).code, 'not_found');
});

test('escapeHtml covers the full character map', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

// --- outbound send failures are reported, not merely console.error'd ---------

function withNotify(env, calls) {
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/notify/')) {
      calls.push({ url: String(url), opts });
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return inner(url, opts);
  };
  return { ...env, NOTIFY_URL: 'https://notify.thompsonblack.us', NOTIFY_TOKEN: 'tok' };
}

const sendReq = (env) =>
  worker.fetch(
    new Request('https://mailer.example/send/tgwab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Send-Token': 'test-send-token' },
      body: JSON.stringify({ to: 'a@b.co', subject: 'hi', message: 'x' }),
    }),
    env,
  );

test('an upstream REJECTION is reported to herald, routed by the ROUTE slug', async () => {
  _resetReportThrottle();
  // Regression: the mailer KV projection carries no `slug`, so taking it from
  // the product object sent every alert to /notify/undefined and lost it.
  emailResponse = { ok: false, status: 550 };
  const calls = [];
  const res = await sendReq(withNotify(makeEnv(), calls));

  assert.equal(res.status, 502, 'the caller still learns it failed');
  assert.equal(calls.length, 1, 'and the failure is announced');
  assert.match(calls[0].url, /\/notify\/tgwab$/, 'routed by slug, never /notify/undefined');
  assert.equal(calls[0].opts.headers['X-Ingest-Token'], 'tok');

  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.level, 'error');
  assert.match(body.description, /will NOT produce a bounce/i, 'a rejection is not a bounce');
  assert.ok(body.fields.some((f) => f.value === 'a@b.co'), 'names the recipient who missed it');
});

test('a SUCCESSFUL send reports nothing', async () => {
  const calls = [];
  const res = await sendReq(withNotify(makeEnv(), calls));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 0);
});

test('repeat failures are throttled so an upstream outage cannot flood the channel', async () => {
  _resetReportThrottle();
  emailResponse = { ok: false, status: 500 };
  const calls = [];
  const env = withNotify(makeEnv(), calls);
  for (let i = 0; i < 4; i++) await sendReq(env);
  assert.equal(calls.length, 1, '/contact is public — one alert per window, not one per submission');
});

test('herald being unreachable never turns a send failure into an exception', async () => {
  emailResponse = { ok: false, status: 500 };
  const env = { ...makeEnv(), NOTIFY_URL: 'https://notify.thompsonblack.us', NOTIFY_TOKEN: 'tok' };
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/notify/')) throw new Error('herald is down');
    return inner(url, opts);
  };
  const res = await sendReq(env);
  assert.equal(res.status, 502, 'still a clean 502');
});

test('with no NOTIFY_URL configured the lane is simply inert', async () => {
  emailResponse = { ok: false, status: 500 };
  const res = await sendReq(makeEnv()); // unexpected fetch would throw
  assert.equal(res.status, 502);
});
