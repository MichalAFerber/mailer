// /send limits measured by uploadwizard-app#95: the subject cap, the blocks
// table cutoff, and the message lane's text/plain part. Outbound fetches are
// stubbed; anything unrecognised throws.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { renderEmail } from '../src/template.js';

class FakeKV {
  constructor(entries) {
    this.entries = entries;
  }
  async get(key) {
    return this.entries[key] ?? null;
  }
}

const PRODUCT = {
  name: 'UploadWizard',
  domain: 'uploadwizard.app',
  from_addr: 'noreply@uploadwizard.app',
  contact_to: 'ops@uploadwizard.app',
  allowed_origins: ['https://uploadwizard.app'],
};
const ENV = {
  PRODUCTS: new FakeKV({ 'product:uw': PRODUCT }),
  FORWARDEMAIL_API_KEY: 'test-fe-key',
  TURNSTILE_SECRET: 'test-turnstile-secret',
  SEND_TOKEN: 'test-send-token',
};

let emailCalls;
const realFetch = globalThis.fetch;
beforeEach(() => {
  emailCalls = [];
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
});

const send = (body) => worker.fetch(
  new Request('https://mailer.example/send/uw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Send-Token': 'test-send-token' },
    body: JSON.stringify(body),
  }),
  ENV,
);

// ── subject ────────────────────────────────────────────────────────────────

test('subject: 300 characters are delivered whole', async () => {
  const subject = 'S'.repeat(299) + 'Z';
  assert.equal((await send({ subject, message: 'x' })).status, 200);
  assert.equal(emailCalls[0].subject, subject);
});

test('subject: past 300 characters it is clamped, not rejected', async () => {
  const subject = 'S'.repeat(300) + 'OVER';
  assert.equal((await send({ subject, message: 'x' })).status, 200);
  assert.equal(emailCalls[0].subject, 'S'.repeat(300));
});

test('subject: a 178-character forwarded-upload subject survives in every lane', async () => {
  // The uploadwizard-app#95 shape: "<n> new files from <uploader> — <brand>".
  const subject = `72 new files from ${'a'.repeat(132)}@uploader.example.com — Acme`;
  assert.equal(subject.length, 178);
  for (const lane of [{ message: 'x' }, { markdown: '# Hi' }, { blocks: [{ type: 'text', body: 'x' }] }]) {
    emailCalls = [];
    assert.equal((await send({ subject, ...lane })).status, 200);
    assert.equal(emailCalls[0].subject, subject, `clamped in the ${Object.keys(lane)[0]} lane`);
  }
});

test('subject: /contact keeps its 150-character cap', async () => {
  const res = await worker.fetch(
    new Request('https://mailer.example/contact/uw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://uploadwizard.app' },
      body: JSON.stringify({
        name: 'Jamie', email: 'jamie@example.com', message: 'Hello', turnstileToken: 'tok', subject: 'C'.repeat(200),
      }),
    }),
    ENV,
  );
  assert.equal(res.status, 200);
  assert.equal(emailCalls[0].subject, `UploadWizard⎯${'C'.repeat(150)}`);
});

// ── message lane text/plain ────────────────────────────────────────────────

test('message lane: the text/plain part is the message, alongside the HTML', async () => {
  const message = 'Backups\n━━ Hosts\n| host | age |\n| r2d2 | 2h |\n\nAll <fresh> & current.';
  assert.equal((await send({ subject: 'Report', message })).status, 200);
  assert.equal(emailCalls.length, 1);
  assert.match(emailCalls[0].html, /^<!DOCTYPE html/i, 'the HTML part still ships');
  assert.match(emailCalls[0].html, /All &lt;fresh&gt; &amp; current\./);
  assert.equal(emailCalls[0].text, message);
});

// ── blocks table cutoff ────────────────────────────────────────────────────

const BRAND = {
  name: 'UploadWizard',
  logoUrl: 'https://uploadwizard.app/icon-192.png',
  accent: '#a8322a',
  footerNotice: 'Sent by UploadWizard from noreply@uploadwizard.app.',
  footerLegal: 'ThompsonBlack LLC · PO Box 3071, Florence SC 29502',
};

// A presigned Wasabi URL of the length uploadwizard-app measured: 614 bytes.
function presigned(i) {
  const base = `https://s3.wasabisys.com/uw-uploads/tenant/${String(i).padStart(4, '0')}-report.pdf`
    + '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260913%2Fus-east-1%2Fs3%2Faws4_request'
    + `&X-Amz-Date=20260913T000000Z&X-Amz-Expires=604800&X-Amz-SignedHeaders=host&X-Amz-Signature=${'f'.repeat(64)}`;
  return `${base}&pad=${'p'.repeat(614 - base.length - 5)}`;
}

// The forwarded-upload table in the shape uploadwizard-app#95 sends: the filename
// cell links to its presigned URL, and the second column is the size.
const forwarded = (n) => ({
  brand: BRAND,
  subject: `${n} new files from client@example.com — Acme`,
  preheader: `${n} new files`,
  blocks: [
    { type: 'title', heading: `${n} new files to Acme`, lede: `client@example.com uploaded ${n} files. Links are valid for 7 days.` },
    {
      type: 'table',
      columns: ['File', 'Size'],
      rows: Array.from({ length: n }, (_, i) => [{ text: `${String(i).padStart(4, '0')}-report.pdf`, href: presigned(i) }, '184.2 KB']),
    },
  ],
});

const links = (html) => (html.match(/-report\.pdf<\/a>/g) || []).length;
// Hrefs are HTML-escaped in the markup, so compare against the escaped form.
const inHtml = (html, url) => html.includes(url.replaceAll('&', '&amp;'));
const moreRows = (html) => html.match(/\+\d+ more/g) || [];

// The smallest file count whose table no longer renders whole, found by
// measurement rather than hardcoded, so the tests follow the budget.
function firstOverflow() {
  for (let n = 1; n <= 500; n++) if (links(renderEmail(forwarded(n)).html) < n) return n;
  throw new Error('no overflow within 500 rows');
}

test('fixture: presigned URLs are 614 bytes', () => {
  assert.equal(presigned(7).length, 614);
});

test('table: one row under the budget renders every row and no "+N more"', () => {
  const n = firstOverflow() - 1;
  const { html } = renderEmail(forwarded(n));
  assert.equal(links(html), n);
  assert.deepEqual(moreRows(html), []);
  assert.doesNotMatch(html, /Message truncated/);
});

test('table: at the first row over budget, rows drop from the end behind one "+N more" row', () => {
  const n = firstOverflow();
  const { html } = renderEmail(forwarded(n));
  const kept = links(html);
  assert.ok(kept >= 1, `the table was dropped whole (kept ${kept} of ${n} links)`);
  assert.deepEqual(moreRows(html), [`+${n - kept} more`]);
  assert.doesNotMatch(html, /Message truncated/, 'a trimmed table is not a dropped block');
  assert.ok(inHtml(html, presigned(kept - 1)), 'the kept rows are the first ones');
  assert.ok(!inHtml(html, presigned(kept)), 'rows drop from the end');
  assert.ok(html.length < 100_000, `rendered ${html.length} bytes`);
});

test('table: far past the budget (150 files) it keeps its first rows, and text keeps all 150', () => {
  const n = 150;
  assert.ok(n > firstOverflow() * 1.5, 'the fixture must be well past the budget for this to mean anything');
  const { html, text } = renderEmail(forwarded(n));
  const kept = links(html);
  assert.ok(kept >= 1 && kept < n, `kept ${kept} of ${n} links`);
  assert.deepEqual(moreRows(html), [`+${n - kept} more`]);
  assert.doesNotMatch(html, /Message truncated/);
  assert.ok(html.length < 100_000, `rendered ${html.length} bytes`);
  assert.ok(text.includes(presigned(n - 1)), 'the text part is not budgeted and keeps every link');
});
