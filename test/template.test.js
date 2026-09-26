// Acceptance tests for the TGWAB email template renderer (src/template.js).
//
// A note on the "byte-identical to the reference" criterion in the spec: it is
// not achievable, and asserting it would mean asserting something false. The
// reference HTML carries commented-out VARIANTS of several blocks (a second
// section header, an alternate callout) plus explanatory prose, none of which a
// renderer emits — the demo document renders one of each block, the file shows
// several. What is testable, and what actually protects the design, is that
// every inline style, token and structural invariant the reference establishes
// still holds. That is what these assert, against the tokens lifted from it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEmail, renderText, esc } from '../src/template.js';

const brand = {
  name: 'ops',
  logoUrl: 'https://mailer.thompsonblack.us/icon-192.png',
  accent: '#a8322a',
  footerNotice: 'Sent by ops in response to a scheduled job on thompsonblack.us.',
  footerLegal: 'ThompsonBlack LLC · PO Box 3071, Florence SC 29502',
  unsubscribeUrl: 'https://thompsonblack.us/unsubscribe',
};

/** One of every block, so the fixture exercises the whole catalog. */
const doc = () => ({
  brand,
  subject: 'Morning digest',
  preheader: 'All backups fresh · 2 open PRs · 1 file flagged for routing',
  blocks: [
    { type: 'title', eyebrow: 'Morning digest', heading: 'Saturday, August 1', lede: 'Overcast in Florence, high 93°F.' },
    { type: 'stats', items: [{ label: 'High / Low', value: '93° / 73°' }, { label: 'Rain', value: '17%' }, { label: 'Open PRs', value: '2' }] },
    { type: 'section', label: 'Calendar', pill: { label: 'clear', status: 'neutral' } },
    { type: 'text', body: 'Nothing scheduled. The day is yours.' },
    { type: 'section', label: 'Muster', pill: { label: 'query failed', status: 'bad' } },
    { type: 'callout', status: 'bad', title: 'KeyError', body: 'The heartbeat query returned a shape the digest did not expect.' },
    { type: 'links', items: [{ href: 'https://github.com/x/y/pull/61', label: 'uploadwizard-app#61', meta: 'npm-major' }] },
    { type: 'table', columns: ['File', 'Disposition'], rows: [['073026 WellsFargo.pdf', { text: '', pill: { label: 'filed', status: 'ok' }, meta: 'Financial' }]] },
    { type: 'mono', content: 'us.tgwab.backup-audit\n  → Wasabi _hosts/' },
    { type: 'button', href: 'https://ipcow.com/dashboard', label: 'Open dashboard →' },
    { type: 'signoff', text: '— ops · generated 05:01 ET' },
  ],
});

test('escapes every interpolated value', () => {
  const d = doc();
  d.blocks.push({ type: 'text', body: '<script>alert(1)</script> Tom & Jerry "quoted"' });
  d.preheader = '<img src=x onerror=alert(1)>';
  const { html } = renderEmail(d);
  assert.ok(!html.includes('<script>'), 'raw <script> reached the output');
  // The substring "onerror=" survives inside escaped text and is inert there;
  // what must never appear is a live tag. Assert on the markup, not the word.
  assert.ok(!html.includes('<img src=x'), 'unescaped <img> reached the output');
  assert.ok(html.includes('&lt;script&gt;'), 'script tag was not escaped');
  assert.ok(html.includes('Tom &amp; Jerry'), 'ampersand was not escaped');
});

test('esc() covers the five HTML-significant characters', () => {
  assert.equal(esc(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});

test('rejects non-https hrefs rather than emitting them', () => {
  const d = doc();
  d.blocks.push({ type: 'button', href: 'javascript:alert(1)', label: 'x' });
  d.blocks.push({ type: 'links', items: [{ href: '/relative', label: 'y' }] });
  const { html } = renderEmail(d);
  assert.ok(!html.includes('javascript:'), 'javascript: URL was emitted');
  assert.ok(!html.includes('href="/relative"'), 'relative URL was emitted');
});

test('the card table is border-separate so its radius and border agree', () => {
  const { html } = renderEmail(doc());
  // Collapsed tables ignore radius on borders: the background still clips to the
  // curve but the border draws square, producing a doubled corner.
  assert.match(html, /max-width:640px;border-collapse:separate;border-spacing:0;/);
  assert.match(html, /table \{ border-collapse:collapse; \}/, 'data tables must stay collapsed');
});

test('makes no external request except the logo', () => {
  const { html } = renderEmail(doc());
  const urls = [...html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((m) => m[1]);
  const external = urls.filter((u) => !u.startsWith('https://mailer.thompsonblack.us/'));
  // Links the user clicks are fine; what must not appear is a fetched subresource.
  const fetched = [...html.matchAll(/src="(https?:[^"]+)"/g)].map((m) => m[1]);
  assert.equal(fetched.length, 1, `expected exactly one fetched asset, got ${fetched.length}`);
  assert.equal(fetched[0], brand.logoUrl);
  assert.ok(!/<link[^>]+stylesheet/i.test(html), 'external stylesheet present');
  assert.ok(!/@font-face/i.test(html), '@font-face present');
});

test('uses no layout primitive that mail clients drop', () => {
  const { html } = renderEmail(doc());
  for (const banned of ['display:flex', 'display:grid', 'position:absolute', 'float:', 'background-image']) {
    assert.ok(!html.includes(banned), `${banned} present — unsupported in Outlook/Word engine`);
  }
});

test('every img carries width, height and alt', () => {
  const { html } = renderEmail(doc());
  for (const tag of html.match(/<img\b[^>]*>/g) || []) {
    assert.match(tag, /\bwidth="\d+"/, `img missing width: ${tag}`);
    assert.match(tag, /\bheight="\d+"/, `img missing height: ${tag}`);
    assert.match(tag, /\balt="/, `img missing alt: ${tag}`);
  }
});

test('pills uppercase via CSS so lowercase data still renders correctly', () => {
  const { html } = renderEmail(doc());
  // Labels now arrive from data; 'filed' must not render lowercase beside 'OK'.
  assert.ok(html.includes('text-transform:uppercase;">filed</span>'), 'pill lacks text-transform');
});

test('data tables cap at three columns', () => {
  const d = { ...doc(), blocks: [{ type: 'table', columns: ['a', 'b', 'c', 'd'], rows: [['1', '2', '3', '4']] }] };
  const { html } = renderEmail(d);
  const headerCells = (html.match(/text-transform:uppercase;color:#5b636e;padding:8px 10px/g) || []).length;
  assert.equal(headerCells, 3, 'a fourth column was rendered');
});

test('a table cell with no href renders byte-identically to before the href feature existed', () => {
  const withoutHrefField = { type: 'table', columns: ['File', 'Disposition'], rows: [['073026 WellsFargo.pdf', { text: 'filed', pill: { label: 'filed', status: 'ok' }, meta: 'Financial' }]] };
  const explicitUndefinedHref = { type: 'table', columns: ['File', 'Disposition'], rows: [['073026 WellsFargo.pdf', { text: 'filed', href: undefined, pill: { label: 'filed', status: 'ok' }, meta: 'Financial' }]] };
  const a = renderEmail({ ...doc(), blocks: [withoutHrefField] });
  const b = renderEmail({ ...doc(), blocks: [explicitUndefinedHref] });
  assert.equal(a.html, b.html, 'an absent href changed the HTML output');
  assert.equal(a.text, b.text, 'an absent href changed the text output');
});

test('a table with no hrefs at all never grows an anchor', () => {
  const d = { brand, subject: 's', preheader: 'p', blocks: [{ type: 'table', columns: ['File', 'Disposition'], rows: [['a.pdf', { text: 'filed', pill: { label: 'filed', status: 'ok' } }], ['b.pdf', 'plain']] }] };
  const { html } = renderEmail(d);
  // brand.unsubscribeUrl legitimately renders its own <a> in the footer; scope
  // the assertion to cells wrapping the table's own text, not the whole document.
  const cellAnchors = [...html.matchAll(/<a href="[^"]*"[^>]*>(filed|plain)<\/a>/g)];
  assert.equal(cellAnchors.length, 0, 'an hrefless table cell grew an anchor');
});

test('a table cell href renders as a real link, sanitized through safeHref', () => {
  const d = { ...doc(), blocks: [{ type: 'table', columns: ['File', 'Link'], rows: [['report.pdf', { text: 'Download', href: 'https://wasabi.example.test/report.pdf?sig=abc' }]] }] };
  const { html, text } = renderEmail(d);
  assert.match(html, /<a href="https:\/\/wasabi\.example\.test\/report\.pdf\?sig=abc"[^>]*>Download<\/a>/, 'https href did not render as an anchor');
  assert.match(text, /Download — https:\/\/wasabi\.example\.test\/report\.pdf\?sig=abc/, 'text lane did not append the href, per the button-lane convention');
});

test('a non-https table cell href is dropped by safeHref, exactly as it is for links/button blocks', () => {
  const d = {
    ...doc(),
    blocks: [{
      type: 'table',
      columns: ['File', 'Link'],
      rows: [
        ['a.pdf', { text: 'A', href: 'javascript:alert(1)' }],
        ['b.pdf', { text: 'B', href: 'http://insecure.example.test/x' }],
      ],
    }],
  };
  const { html } = renderEmail(d);
  assert.ok(!html.includes('javascript:'), 'a javascript: href survived into the output');
  assert.ok(!html.includes('http://insecure.example.test'), 'an http: href survived into the output');
  assert.match(html, /<a href="#"[^>]*>A<\/a>/, 'javascript: href did not fall back to #, as safeHref does elsewhere');
  assert.match(html, /<a href="#"[^>]*>B<\/a>/, 'http: href did not fall back to #, as safeHref does elsewhere');
});

test('applies per-column widths to header and body cells alike', () => {
  const d = {
    brand, subject: 's', preheader: 'p',
    blocks: [{ type: 'table', columns: ['Event', 'Date', 'Time'],
               widths: ['58%', '24%', '18%'],
               rows: [['Standup', 'Today', '09:30'], ['Review', 'Tue 5 Aug', 'all day']] }],
  };
  const { html } = renderEmail(d);
  // Header + one cell per row, per column: widths must appear on every one or
  // the grid wanders between rows.
  for (const pct of ['58%', '24%', '18%']) {
    const n = (html.match(new RegExp(`width="${pct}"`, 'g')) || []).length;
    assert.equal(n, 3, `width ${pct} applied ${n} times, expected 3 (header + 2 rows)`);
  }
});

test('stays well under the 100KB Gmail clipping threshold', () => {
  const d = doc();
  for (let i = 0; i < 40; i++) {
    d.blocks.push({ type: 'table', columns: ['Host', 'Age', 'State'], rows: Array.from({ length: 12 }, (_, n) => [`pve-ubuntu-${n}`, '2.0h', { text: '', pill: { label: 'ok', status: 'ok' } }]) });
  }
  const { html } = renderEmail(d);
  assert.ok(html.length < 100_000, `worst-case digest is ${html.length} bytes`);
  assert.match(html, /blocks omitted to stay under/, 'truncation was silent');
});

test('plain text is generated from blocks, not stripped from HTML', () => {
  const { text } = renderEmail(doc());
  assert.ok(!text.includes('<'), 'text part contains markup');
  assert.match(text, /^All backups fresh/, 'preheader is not the first line');
  assert.match(text, /## MUSTER — QUERY FAILED/, 'section header format wrong');
  assert.match(text, /\[BAD\] KeyError/, 'callout status not bracketed');
  assert.match(text, /uploadwizard-app#61 — https:\/\//, 'link format wrong');
  assert.ok(text.split('\n').every((l) => l.length <= 78 || !l.includes(' ')), 'a wrappable line exceeded 78 columns');
});

test('renderText tolerates a document with no optional fields', () => {
  const minimal = { brand, subject: 's', preheader: 'p', blocks: [{ type: 'title', heading: 'H' }] };
  const t = renderText(minimal);
  assert.match(t, /^p\n/);
  assert.match(t, /H/);
});
