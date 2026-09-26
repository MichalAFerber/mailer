// The chrome both rendered /send lanes share: the markdown lane (src/email.js on
// src/layout.html.js) and the block lane (src/template.js). A product must look
// identical whichever lane it sends through (the invariant above brandOf in
// src/index.js), so every assertion here runs against both.
//
// Owner decision 2026-09-25, after a contact email read as "a card inside another
// card": one card on a white page with its thin border kept, no accent hairline,
// the logomark aligned with the card's content, every mono block unboxed, and no
// dark mode.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEmail as renderMarkdownEmail } from '../src/email.js';
import { renderEmail as renderBlocks } from '../src/template.js';
import { FIXTURE } from '../src/fixture.js';

const ACCENT = FIXTURE.brand.accent;

// A mono block after another block, as FIXTURE's fence follows a list.
const BLOCK_DOC = {
  brand: {
    name: 'ops',
    logoUrl: FIXTURE.brand.logoUrl,
    accent: ACCENT,
    footerNotice: FIXTURE.brand.footerNotice,
    footerLegal: FIXTURE.brand.footerPostal,
  },
  subject: 'Morning digest',
  preheader: 'All backups fresh',
  blocks: [
    { type: 'title', heading: 'Saturday, August 1' },
    { type: 'text', body: 'Nothing scheduled. The day is yours.' },
    { type: 'mono', content: 'us.tgwab.backup-audit\n  → Wasabi _hosts/' },
  ],
};

const LANES = {
  markdown: () => renderMarkdownEmail(FIXTURE).html,
  blocks: () => renderBlocks(BLOCK_DOC).html,
};

// The body of the max-width:600px query, up to its closing brace.
const mobileRules = (html) => {
  const start = html.indexOf('@media only screen and (max-width:600px)');
  assert.ok(start >= 0, 'no mobile media query');
  return html.slice(start, html.indexOf('\n  }', start));
};

for (const [lane, render] of Object.entries(LANES)) {
  test(`${lane} lane: the page is white and the card keeps its thin border`, () => {
    const html = render();
    assert.ok(!html.includes('#eceef1'), 'the grey page color is back');
    assert.match(html, /<body class="page" style="[^"]*background:#ffffff;/, 'body does not paint the page white');
    assert.match(html, /bgcolor="#ffffff" class="page" style="background:#ffffff;"/,
      'the outer wrap table does not paint the page white');
    assert.match(html, /class="card" style="background:#ffffff;border-radius:16px;border:1px solid #dfe3e8;padding:40px 36px;"/,
      'the card lost its fill, border, radius, or padding');
  });

  test(`${lane} lane: no accent hairline, so the accent is only the wordmark dot`, () => {
    const html = render();
    assert.ok(!html.includes('width:44px'), 'the 44px accent hairline is back');
    assert.ok(!html.includes('height="3"'), 'the 3px accent hairline row is back');
    const accents = html.split(ACCENT).length - 1;
    assert.equal(accents, 1, `the accent appears ${accents} times; only the wordmark dot should carry it`);
    assert.ok(html.includes(`<span style="color:${ACCENT};">.</span>`), 'the wordmark dot lost the accent');
  });

  test(`${lane} lane: the logomark lines up with the card content and the footer`, () => {
    const html = render();
    // 37px = the card's 36px side padding + its 1px border; on phones the card
    // pads 20px, so 21px. The footer has always used the same inset.
    assert.match(html, /<td class="head-pad" style="padding:0 37px 18px 37px;">/, 'the header is not inset to the card content');
    assert.match(html, /<td class="foot-pad" style="padding:22px 37px 0 37px;">/, 'the footer inset changed');
    const mobile = mobileRules(html);
    assert.match(mobile, /\.card\s+\{ padding:28px 20px !important; border-radius:12px !important; \}/, 'the mobile card rule changed');
    assert.match(mobile, /\.head-pad \{ padding:0 21px 18px 21px !important; \}/, 'no mobile .head-pad rule');
    assert.match(mobile, /\.foot-pad \{ padding:20px 21px 0 21px !important; \}/, 'the mobile footer inset changed');
  });

  test(`${lane} lane: light only, with no dark-mode stylesheet`, () => {
    const html = render();
    assert.ok(!html.includes('prefers-color-scheme'), 'a dark-mode stylesheet is back');
    const schemes = [...html.matchAll(/<meta name="((?:supported-)?color-schemes?)" content="([^"]*)">/g)]
      .map((m) => `${m[1]}=${m[2]}`);
    assert.deepEqual(schemes, ['color-scheme=light', 'supported-color-schemes=light']);
  });

  test(`${lane} lane: the mono block is unboxed`, () => {
    const html = render();
    const tags = html.match(/<div class="mono-blk[^"]*"[^>]*>/g) || [];
    assert.equal(tags.length, 1, `expected one mono block, found ${tags.length}`);
    const [tag] = tags;
    assert.doesNotMatch(tag, /#f5f6f8|background|border|padding/, `the mono block is boxed again: ${tag}`);
    assert.match(tag, /white-space:pre-wrap;word-break:break-word;/, 'the mono block lost pre-wrap');
    assert.match(tag, /margin-top:\d+px;/, 'a mono block after another block lost its separating margin');
    assert.doesNotMatch(mobileRules(html), /\.mono-blk[^}]*padding/, 'the mobile rule pads the mono block again');
  });
}
