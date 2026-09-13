// The brand-override lane (mailer#36 Fix B). Runs the sanitizer on
// html-rewriter-wasm (see html-rewriter-shim.js); /selftest repeats the fixtures
// on workerd's own HTMLRewriter after every deploy.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {
  sanitizeHtml, prepareBrandOverride, BRAND_OVERRIDE_LIMITS, SANITIZER_FIXTURES,
} from '../src/sanitize.js';
import { HTMLRewriter, installHTMLRewriter } from './html-rewriter-shim.js';

installHTMLRewriter();

class FakeKV {
  constructor(entries) {
    this.entries = entries;
  }
  async get(key) {
    return this.entries[key] ?? null;
  }
}

const BASE = {
  name: 'UploadWizard',
  domain: 'uploadwizard.app',
  from_addr: 'noreply@uploadwizard.app',
  contact_to: 'ops@uploadwizard.app',
  allowed_origins: ['https://uploadwizard.app'],
};
const FLAGGED = { ...BASE, white_label: true, transactional_only: true };

const envFor = (product) => ({
  PRODUCTS: new FakeKV({ 'product:uw': product }),
  FORWARDEMAIL_API_KEY: 'test-fe-key',
  TURNSTILE_SECRET: 'test-turnstile-secret',
  SEND_TOKEN: 'test-send-token',
});

let emailCalls;
const realFetch = globalThis.fetch;
beforeEach(() => {
  emailCalls = [];
  // Every outbound call is stubbed; anything unrecognised throws, so no test can
  // reach Forward Email or Turnstile for real.
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('challenges.cloudflare.com')) {
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    if (String(url).includes('api.forwardemail.net')) {
      emailCalls.push(Object.fromEntries(new URLSearchParams(opts.body)));
      return { ok: true, status: 200, json: async () => ({ id: 'msg-1' }) };
    }
    throw new Error('unexpected fetch: ' + url);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.HTMLRewriter = HTMLRewriter;
});

const send = (body, product = FLAGGED) => worker.fetch(
  new Request('https://mailer.example/send/uw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Send-Token': 'test-send-token' },
    body: JSON.stringify(body),
  }),
  envFor(product),
);

const override = (extra = {}) => ({
  html: '<!DOCTYPE html><html><body><p>Sign in to Acme</p><a href="https://acme.test/l">Sign in</a></body></html>',
  text: 'Sign in to Acme: https://acme.test/l',
  suppress_platform_wrapper: true,
  ...extra,
});

async function expect400(res, pattern) {
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'bad_payload');
  if (pattern) assert.match(body.error, pattern);
  assert.equal(emailCalls.length, 0, 'a rejected payload sends nothing');
}

// ── sanitizer ──────────────────────────────────────────────────────────────

for (const f of SANITIZER_FIXTURES) {
  test(`sanitizer: ${f.name}`, async () => {
    assert.match(f.html, f.absent, 'the detector must match the hostile input, or its absence proves nothing');
    const out = await sanitizeHtml(f.html);
    assert.doesNotMatch(out, f.absent);
    if (f.present) assert.match(out, f.present, `benign content must survive: ${out}`);
  });
}

test('sanitizer: every on* attribute goes, including adjacent ones', async () => {
  // Removing while iterating the live attribute list would skip every second one.
  const out = await sanitizeHtml('<div onclick="a()" onmouseover="b()" ONLOAD="c()" onfocus="d()" class="k">x</div>');
  assert.equal(out, '<div class="k">x</div>');
});

test('sanitizer: https URLs survive in every URL attribute', async () => {
  const html = '<a href="https://ok.test/a">a</a><img src="HTTPS://ok.test/i.png" srcset="https://ok.test/1.png 1x, https://ok.test/2.png 2x">'
    + '<button formaction="https://ok.test/f">b</button><td background="https://ok.test/bg.png">c</td>'
    + '<video poster="https://ok.test/p.png"></video><svg><a xlink:href="https://ok.test/x">d</a></svg>';
  const out = await sanitizeHtml(html);
  for (const url of ['https://ok.test/a', 'HTTPS://ok.test/i.png', 'https://ok.test/2.png 2x', 'https://ok.test/f',
    'https://ok.test/bg.png', 'https://ok.test/p.png', 'https://ok.test/x']) {
    assert.ok(out.includes(url), `${url} should survive in ${out}`);
  }
});

test('sanitizer: an entity-encoded scheme is not https, so it is dropped', async () => {
  const out = await sanitizeHtml('<a href="&#106;avascript:alert(1)">go</a>');
  assert.equal(out, '<a>go</a>');
});

test('sanitizer: an unterminated script takes the rest of the document with it', async () => {
  const out = await sanitizeHtml('<p>kept</p><script>alert(1)');
  assert.equal(out, '<p>kept</p>');
});

test('sanitizer: authored email markup it has no rule against is left alone', async () => {
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>p{color:#111}</style></head>'
    + '<body><!--[if mso]><table><tr><td><![endif]--><p style="color:#222">Hi<o:p></o:p></p></body></html>';
  assert.equal(await sanitizeHtml(html), html);
});

// ── the gate ───────────────────────────────────────────────────────────────

test('gate: a product without white_label gets 400, even with transactional_only', async () => {
  await expect400(await send({ subject: 'Hi', brand_override: override() }, { ...BASE, transactional_only: true }), /not enabled/);
});

test('gate: white_label must be literally true, not truthy', async () => {
  await expect400(await send({ subject: 'Hi', brand_override: override() }, { ...FLAGGED, white_label: 'true' }), /not enabled/);
  await expect400(await send({ subject: 'Hi', brand_override: override() }, { ...FLAGGED, white_label: 1 }), /not enabled/);
});

test('gate: white_label without transactional_only gets 400', async () => {
  await expect400(await send({ subject: 'Hi', brand_override: override() }, { ...BASE, white_label: true }), /transactional_only/);
});

test('gate: suppress_platform_wrapper false or missing gets 400', async () => {
  await expect400(await send({ subject: 'Hi', brand_override: override({ suppress_platform_wrapper: false }) }), /suppress_platform_wrapper/);
  const { suppress_platform_wrapper: _omit, ...missing } = override();
  await expect400(await send({ subject: 'Hi', brand_override: missing }), /suppress_platform_wrapper/);
});

test('gate: a non-object brand_override gets 400', async () => {
  for (const bad of [null, 'html', ['<p>x</p>'], 7]) {
    await expect400(await send({ subject: 'Hi', brand_override: bad }), /must be an object/);
  }
});

test('gate: brand_override cannot carry From or any other field', async () => {
  await expect400(await send({ subject: 'Hi', brand_override: override({ from: 'ceo@capturewizard.app' }) }), /does not accept: from/);
});

test('gate: html is required and text must be a string', async () => {
  await expect400(await send({ subject: 'Hi', brand_override: override({ html: '' }) }), /html is required/);
  await expect400(await send({ subject: 'Hi', brand_override: override({ text: 42 }) }), /text must be a string/);
});

test('gate: brand_override cannot be combined with another lane', async () => {
  await expect400(await send({ subject: 'Hi', message: 'x', brand_override: override() }), /cannot be combined/);
  await expect400(await send({ subject: 'Hi', markdown: '# x', brand_override: override() }), /cannot be combined/);
  await expect400(await send({ subject: 'Hi', blocks: [], brand_override: override() }), /cannot be combined/);
});

test('gate: subject is still required', async () => {
  await expect400(await send({ brand_override: override() }));
});

// ── size caps ──────────────────────────────────────────────────────────────

test('cap: the shipped limits are 90,000 bytes for html and text', () => {
  assert.deepEqual(BRAND_OVERRIDE_LIMITS, { html_bytes: 90000, text_bytes: 90000 });
});

test('cap: sanitized html over 90,000 bytes is rejected, not truncated', async () => {
  const html = `<p>${'a'.repeat(BRAND_OVERRIDE_LIMITS.html_bytes)}</p>`;
  await expect400(await send({ subject: 'Hi', brand_override: override({ html }) }), /exceeds 90000 bytes after sanitizing/);
});

test('cap: the limit is measured in bytes, not characters', async () => {
  // 30,001 three-byte characters are 90,003 bytes but only 30,001 characters.
  const html = '€'.repeat(30001);
  assert.ok(html.length < BRAND_OVERRIDE_LIMITS.html_bytes);
  await expect400(await send({ subject: 'Hi', brand_override: override({ html }) }), /exceeds/);
});

test('cap: applies to the output, so input that shrinks under it is accepted', async () => {
  const html = `<p>kept</p><script>${'a'.repeat(BRAND_OVERRIDE_LIMITS.html_bytes)}</script>`;
  const res = await send({ subject: 'Hi', brand_override: override({ html }) });
  assert.equal(res.status, 200);
  assert.equal(emailCalls[0].html, '<p>kept</p>');
});

test('cap: exactly 90,000 bytes of output is accepted', async () => {
  const html = `<p>${'a'.repeat(BRAND_OVERRIDE_LIMITS.html_bytes - 7)}</p>`;
  assert.equal(new TextEncoder().encode(html).length, BRAND_OVERRIDE_LIMITS.html_bytes);
  assert.equal((await send({ subject: 'Hi', brand_override: override({ html }) })).status, 200);
});

test('cap: text over 90,000 bytes is rejected', async () => {
  await expect400(
    await send({ subject: 'Hi', brand_override: override({ text: 'a'.repeat(BRAND_OVERRIDE_LIMITS.text_bytes + 1) }) }),
    /text exceeds/,
  );
});

// ── delivery ───────────────────────────────────────────────────────────────

test('send: the sanitized document replaces the house layout entirely', async () => {
  const res = await send({
    subject: 'Sign in to Acme',
    brand_override: override({ html: '<p>Sign in to Acme</p><script>alert(1)</script><a href="https://acme.test/l" onclick="x()">Sign in</a>' }),
  });
  assert.equal(res.status, 200);
  assert.equal(emailCalls.length, 1);
  const mail = emailCalls[0];
  assert.equal(mail.html, '<p>Sign in to Acme</p><a href="https://acme.test/l">Sign in</a>');
  assert.equal(mail.text, 'Sign in to Acme: https://acme.test/l');
  assert.doesNotMatch(mail.html, /ThompsonBlack|UploadWizard/, 'no platform chrome');
});

test('send: From, Reply-To, CRLF cleaning, and the recipient rule are unchanged', async () => {
  const res = await send({
    to: 'user@example.com',
    reply_to: 'help@acme.test',
    name: 'Acme',
    subject: 'Sign in\r\nBcc: victim@example.com',
    brand_override: override(),
  });
  assert.equal(res.status, 200);
  const mail = emailCalls[0];
  assert.equal(mail.from, 'Acme <noreply@uploadwizard.app>');
  assert.equal(mail.to, 'user@example.com');
  assert.equal(mail.replyTo, 'help@acme.test');
  assert.equal(mail.subject, 'Sign in Bcc: victim@example.com');

  emailCalls = [];
  await expect400(await send({ to: 'a@example.com, b@example.com', subject: 'Hi', brand_override: override() }), /invalid recipient/);
});

test('send: text is optional', async () => {
  const { text: _omit, ...noText } = override();
  assert.equal((await send({ subject: 'Hi', brand_override: noText })).status, 200);
  assert.equal('text' in emailCalls[0], false);
});

test('send: a request without brand_override is identical on a flagged product', async () => {
  for (const body of [
    { subject: 'Hi', message: 'plain' },
    { subject: 'Hi', markdown: '# Hi\n\nBody.' },
    { subject: 'Hi', blocks: [{ type: 'text', text: 'Body.' }] },
  ]) {
    emailCalls = [];
    assert.equal((await send(body, BASE)).status, 200);
    assert.equal((await send(body, FLAGGED)).status, 200);
    assert.deepEqual(emailCalls[1], emailCalls[0], `lane output changed for ${Object.keys(body)}`);
  }
});

test('/contact ignores brand_override entirely', async () => {
  const res = await worker.fetch(
    new Request('https://mailer.example/contact/uw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://uploadwizard.app' },
      body: JSON.stringify({
        name: 'Jamie', email: 'jamie@example.com', message: 'Hello', turnstileToken: 'tok',
        brand_override: override({ html: '<p>OVERRIDE-MARKER</p>' }),
      }),
    }),
    envFor(FLAGGED),
  );
  assert.equal(res.status, 200);
  assert.equal(emailCalls.length, 1);
  assert.doesNotMatch(emailCalls[0].html, /OVERRIDE-MARKER/);
  assert.equal(emailCalls[0].to, 'ops@uploadwizard.app');
});

// ── /selftest ──────────────────────────────────────────────────────────────

test('/selftest runs every sanitizer fixture and gate rule', async () => {
  const res = await worker.fetch(new Request('https://mailer.example/selftest'), {}, {});
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body.brand_override));
  assert.equal(body.brand_override.available, true);
  assert.equal(body.brand_override.ok, true);
  assert.deepEqual(
    Object.keys(body.brand_override.guards).sort(),
    SANITIZER_FIXTURES.map((f) => f.name).sort(),
  );
  assert.ok(Object.values(body.brand_override.guards).every((v) => v === 'stripped'));
  assert.ok(Object.values(body.brand_override.gate).every((v) => v === true), JSON.stringify(body.brand_override.gate));
  for (const name of ['script_uppercase', 'script_malformed_nesting', 'on_attribute_uppercase']) {
    assert.ok(name in body.brand_override.guards, `${name} must be a selftest guard`);
  }
});

test('/selftest answers 500 when the deployed parser stops stripping', async () => {
  // The control: a rewriter that ignores every handler passes markup through
  // untouched. If the verdict does not flip, the guards cannot fail.
  globalThis.HTMLRewriter = class {
    on() {
      return this;
    }
    transform(response) {
      return { text: () => response.text() };
    }
  };
  const res = await worker.fetch(new Request('https://mailer.example/selftest'), {}, {});
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.equal(body.ok, false);
  assert.equal(body.brand_override.guards.script, 'SURVIVED');
  assert.equal(body.brand_override.gate.caps_output_not_input, false);
});

test('/selftest reports the lane unavailable where there is no HTMLRewriter', async () => {
  delete globalThis.HTMLRewriter;
  const body = await (await worker.fetch(new Request('https://mailer.example/selftest'), {}, {})).json();
  assert.deepEqual(body.brand_override, { available: false });
});

test('prepareBrandOverride is the whole gate, independent of the route', async () => {
  const ok = await prepareBrandOverride(FLAGGED, override());
  assert.equal(ok.error, undefined);
  assert.equal(typeof ok.html, 'string');
  assert.ok((await prepareBrandOverride(undefined, override())).error);
});
