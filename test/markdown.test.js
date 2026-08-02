// Acceptance tests for markdown → components.
//
// The one that matters most is `pre-wrap outside the mono block`. That single
// grep would have caught the 2026-08-02 Pages notification immediately: it
// shipped a 16-row table as tab-aligned columns inside a pre-wrap div, which is
// the exact failure the component catalog exists to prevent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownBody, MarkdownError, esc } from '../src/markdown.js';

const r = (md, opts) => renderMarkdownBody(md, opts);

test('pre-wrap appears ONLY inside the mono block', () => {
  const html = r(`# T

| Host | Age | Status |
|---|---|---|
| a | 1h | ok |

Some prose.

- a list item

\`\`\`
raw output
\`\`\`
`);
  const all = (html.match(/white-space:pre-wrap/g) || []).length;
  const inMono = (html.match(/class="mono-blk[^"]*"[^>]*white-space:pre-wrap/g) || []).length;
  assert.equal(all, 1, `pre-wrap used ${all} times`);
  assert.equal(inMono, 1, 'the only pre-wrap must be the mono block');
});

test('a table wider than three columns throws rather than degrading', () => {
  assert.throws(
    () => r('| a | b | c | d |\n|---|---|---|---|\n| 1 | 2 | 3 | 4 |\n'),
    (e) => e instanceof MarkdownError && /4 columns/.test(e.message),
  );
});

test('three columns is allowed', () => {
  assert.ok(r('| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n').includes('<td'));
});

test('pill vocabulary is closed to ok/warn/bad', () => {
  for (const s of ['ok', 'warn', 'bad']) {
    assert.ok(r(`## Section {${s}}`).includes('border-radius:999px'), `${s} should render a pill`);
  }
  assert.throws(() => r('## Section {broken}'), (e) => e instanceof MarkdownError && /only \{ok\}/.test(e.message));
  assert.throws(() => r('## Section {critical}'), MarkdownError);
});

test('one H1 and one button per email', () => {
  assert.throws(() => r('# One\n\n# Two\n'), (e) => e instanceof MarkdownError && /one title/.test(e.message));
  assert.throws(
    () => r('[a](https://x.test){btn}\n\n[b](https://y.test){btn}\n'),
    (e) => e instanceof MarkdownError && /one primary action/.test(e.message),
  );
});

test('raw HTML in the source is escaped, never passed through', () => {
  const html = r('# T\n\nA <script>alert(1)</script> and <img src=x onerror=y> in prose.\n');
  assert.ok(!html.includes('<script'), 'script tag survived');
  assert.ok(!html.includes('<img src=x'), 'img tag survived');
  assert.ok(html.includes('&lt;script&gt;'), 'not escaped');
});

test('non-https links throw rather than degrading to #', () => {
  // §9: fail loudly. A '#' link is a dead end the reader finds by clicking;
  // a throw is found by the author, before it ships.
  assert.throws(() => r('[x](http://insecure.test)'), (e) => e instanceof MarkdownError && /absolute https/.test(e.message));
  assert.throws(() => r('[y](/relative)'), MarkdownError);
  // markdown-it refuses to parse this as a link at all, so there is nothing to
  // throw about — assert the important property instead: no live href escapes.
  const js = r('[z](javascript:alert(1))');
  assert.equal([...js.matchAll(/href="([^"]*)"/g)].length, 0, 'a href was emitted for a rejected link');
  const ok = r('[a](https://ipcow.com/x)');
  assert.ok(ok.includes('href="https://ipcow.com/x"'));
});

test('an unhandled markdown construct throws instead of emitting default HTML', () => {
  // Default output is unclassed output — no dark-mode counterpart. That is the
  // mechanism behind the unreadable Pages notification, not a styling slip.
  assert.throws(() => r('![alt](https://x.test/i.png)\n'), MarkdownError);
});


test('GitHub alerts map to callout statuses', () => {
  assert.ok(r('> [!CAUTION] Bad\n> body\n').includes('#fbe6e4'), 'CAUTION should be bad');
  assert.ok(r('> [!WARNING] Warn\n> body\n').includes('#fbf1dc'), 'WARNING should be warn');
  assert.ok(r('> [!NOTE] Note\n> body\n').includes('#e3f2ea'), 'NOTE should be ok');
});

test('every emitted cell/text carries a class the dark-mode query targets', () => {
  const html = r('# T\n\n## S {ok}\n\nProse.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  // An element with an inline colour and no class keeps it in dark mode, because
  // inline beats the stylesheet. That is gotcha #2, and it shipped once already.
  const coloured = html.match(/<(?:td|div|span|a)[^>]*color:#[0-9a-f]{6}[^>]*>/gi) || [];
  const unclassed = coloured.filter((tag) => !/class="/.test(tag));
  assert.equal(unclassed.length, 0, `${unclassed.length} coloured element(s) without a class: ${unclassed[0]}`);
});

test('the eyebrow comes from the sender, not the markdown', () => {
  assert.ok(!r('# Title').includes('padding:22px 0 8px 0'), 'eyebrow rendered without being asked for');
  assert.ok(r('# Title', { eyebrow: 'Backup audit' }).includes('Backup audit'));
});

test('esc covers the five HTML-significant characters', () => {
  assert.equal(esc(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});

// ── §13 acceptance, against the shared fixture ────────────────────────────

test('fixture: pre-wrap appears once per fence and zero times without one', async () => {
  const { renderEmail } = await import('../src/email.js');
  const { FIXTURE } = await import('../src/fixture.js');
  const fences = (FIXTURE.markdown.match(/^```/gm) || []).length / 2;
  const html = renderEmail(FIXTURE).html;
  assert.equal((html.match(/white-space:pre-wrap/g) || []).length, fences);

  const noFence = renderEmail({ ...FIXTURE, markdown: '# T\n\nProse only.\n' }).html;
  assert.equal((noFence.match(/white-space:pre-wrap/g) || []).length, 0);
});

test('fixture: every inline colour has a dark-mode selector', async () => {
  const { renderEmail } = await import('../src/email.js');
  const { FIXTURE } = await import('../src/fixture.js');
  const html = renderEmail(FIXTURE).html;
  const dark = html.slice(html.indexOf('@media (prefers-color-scheme: dark)'));
  // Accent and semantic status colours are mode-invariant BY DESIGN — the token
  // table gives accent no dark value, and pill/callout fills stay light so they
  // survive clients that strip backgrounds. What must never be unclassed is a
  // NEUTRAL colour: those flip in dark mode, and inline beats the stylesheet.
  const INVARIANT = /#a8322a|#a4231f|#fbe6e4|#0f6b47|#e3f2ea|#8a5a00|#fbf1dc|#7a1e1a/i;
  const coloured = html.match(/<(?:td|div|span|a|li)[^>]*(?:color|background):#[0-9a-f]{6}[^>]*>/gi) || [];
  const unclassed = coloured.filter((t) => !/class="/.test(t) && !INVARIANT.test(t));
  assert.equal(unclassed.length, 0, `neutral-coloured element with no class: ${unclassed[0]}`);
  for (const cls of ['card', 'ink', 'muted', 'rule', 'wash', 'cell', 'mono-blk', 'link', 'btn']) {
    assert.ok(new RegExp(`\\.${cls}[^}]*!important`).test(dark), `.${cls} lacks a dark rule with !important`);
  }
});

test('fixture: no token survives, and no external request but the logo', async () => {
  const { renderEmail } = await import('../src/email.js');
  const { FIXTURE } = await import('../src/fixture.js');
  const html = renderEmail(FIXTURE).html;
  assert.equal((html.match(/\{\{[A-Z_]+\}\}/g) || []).length, 0, 'unreplaced token');
  const fetched = [...html.matchAll(/src="(https?:[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(fetched, [FIXTURE.brand.logoUrl]);
  assert.ok(!/@font-face|<link[^>]+stylesheet/i.test(html));
});

test('fixture: text part differs from source only by the §10 normalizations', async () => {
  const { renderEmail } = await import('../src/email.js');
  const { FIXTURE } = await import('../src/fixture.js');
  const text = renderEmail(FIXTURE).text;
  assert.ok(!text.includes('{bad}') && text.includes('[BAD]'), 'pill marker not normalized');
  assert.ok(!text.includes('{btn}'), '{btn} not stripped');
  assert.ok(text.includes('| Host | Age | Status |'), 'table row was wrapped or altered');
  assert.ok(text.includes('[Open Gatus](https://gatus.thompsonblack.us)'), 'link syntax altered');
  assert.ok(!text.includes('<'), 'markup leaked into the text part');
});

test('worst-case message stays under 100KB', async () => {
  const { renderEmail } = await import('../src/email.js');
  const { FIXTURE } = await import('../src/fixture.js');
  const rows = Array.from({ length: 300 }, (_, n) => `| pve-ubuntu-${n} | ${n}h | ok |`).join('\n');
  // Over the limit must THROW, not silently ship a clipped digest.
  assert.throws(
    () => renderEmail({ ...FIXTURE, markdown: `# T\n\n| Host | Age | Status |\n|---|---|---|\n${rows}\n` }),
    (e) => /move the detail to an artifact/.test(e.message),
  );
  assert.ok(renderEmail(FIXTURE).html.length < 100_000);
});
