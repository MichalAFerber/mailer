// The TGWAB transactional email template, as a block renderer.
//
// The canonical reference is templates/tgwab-email-template.html in
// tgwab-standards — that file is the spec, this is the implementation. If the
// two ever disagree visually, this is wrong. test/template.test.js pins the
// demo document against it as a golden fixture.
//
// Inline styles are copied verbatim from the reference and are the source of
// truth for every visual property; the two <style> blocks carry ONLY the
// responsive and dark-mode overrides, because inline styles beat stylesheet
// rules and a dark-mode rule without !important loses to them. That is how the
// mono block originally shipped near-black on near-black.
//
// Layout is tables throughout. No flex, no grid, no divs-as-layout, no external
// CSS, no web fonts — all of it is dead on arrival in Outlook and most clients.
// JetBrains Mono will not load; the fallback stack IS the design.
//
// JSDoc rather than TypeScript: this Worker is plain ESM with `node --test`,
// and a TS toolchain for one module is not worth the build step.

/** @typedef {'ok'|'warn'|'bad'|'neutral'} Status */
/** @typedef {{ label: string, status: Status }} Pill */
/** @typedef {{ label: string, value: string }} Stat */
/** @typedef {string | { text: string, pill?: Pill, meta?: string }} Cell */

/**
 * @typedef {{ name: string, logoUrl: string, accent: string,
 *             footerNotice: string, footerLegal: string, unsubscribeUrl?: string }} Brand
 */

/**
 * @typedef {{type:'title',eyebrow?:string,heading:string,lede?:string}
 *         | {type:'stats',items:Stat[]}
 *         | {type:'section',label:string,pill?:Pill}
 *         | {type:'text',body:string}
 *         | {type:'callout',status:Status,title:string,body:string}
 *         | {type:'links',items:{href:string,label:string,meta?:string}[]}
 *         | {type:'table',columns:string[],rows:Cell[][],sublabel?:string,widths?:string[]}
 *         | {type:'mono',content:string}
 *         | {type:'button',href:string,label:string}
 *         | {type:'signoff',text:string}} Block
 */

/** @typedef {{ brand: Brand, subject: string, preheader: string, blocks: Block[] }} EmailDoc */

// ── tokens ────────────────────────────────────────────────────────────────
// Every colour in the template comes from here. Do not invent values.
const T = {
  page: '#eceef1', card: '#ffffff', ink: '#14161a', muted: '#5b636e',
  rule: '#dfe3e8', wash: '#f5f6f8',
};

// Pill fills stay light in dark mode by design: the text colour is semantic on
// its own, so the pill still reads in clients that strip backgrounds.
const PILL = {
  ok:      { fg: '#0f6b47', bg: '#e3f2ea' },
  warn:    { fg: '#8a5a00', bg: '#fbf1dc' },
  bad:     { fg: '#a4231f', bg: '#fbe6e4' },
  neutral: { fg: '#5b636e', bg: '#f5f6f8' },
};

const MONO = "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const MONO_S = "'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace";

/** HTML-escape. Digest content is full of &, <, > and file paths. */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Absolute https only — relative and protocol-relative URLs break in mail. */
function safeHref(href) {
  const h = String(href ?? '');
  return /^https:\/\//i.test(h) ? esc(h) : '#';
}

const pillHtml = (p) => {
  const c = PILL[p.status] || PILL.neutral;
  return `<span class="mono" style="font-family:${MONO_S};display:inline-block;padding:3px 9px;` +
    `border-radius:999px;background:${c.bg};color:${c.fg};font-size:10px;font-weight:700;` +
    // text-transform, so a label arriving as lowercase `ok` from data does not
    // render broken beside the hard-typed caps in the reference.
    `letter-spacing:.8px;text-transform:uppercase;">${esc(p.label)}</span>`;
};

const RULE_ROW = `<tr><td colspan="2" height="1" class="rule" style="height:1px;line-height:1px;font-size:0;background:${T.rule};">&nbsp;</td></tr>`;

// ── blocks ────────────────────────────────────────────────────────────────

const blockTitle = (b) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${b.eyebrow ? `<tr><td class="label muted" style="font-family:${MONO};font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${T.muted};padding:22px 0 8px 0;">
        ${esc(b.eyebrow)}
      </td></tr>` : ''}
      <tr><td class="h1 ink" style="font-family:${MONO};font-size:27px;font-weight:700;letter-spacing:-.8px;line-height:1.25;color:${T.ink};">
        ${esc(b.heading)}
      </td></tr>
      ${b.lede ? `<tr><td class="muted" style="font-size:15px;line-height:1.6;color:${T.muted};padding:10px 0 0 0;">
        ${esc(b.lede)}
      </td></tr>` : ''}
    </table>`;

// Exactly three, or it will not stack cleanly on mobile.
const blockStats = (b) => {
  const cell = (s, pad) => `
        <td class="stack ${pad === 'right' ? 'stack-pad' : pad === 'mid' ? 'stack-pad' : ''}" width="33.33%" valign="top" style="${
          pad === 'right' ? 'padding-right:8px;' : pad === 'mid' ? 'padding:0 4px;' : 'padding-left:8px;'}">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${T.wash}" class="wash" style="background:${T.wash};border-radius:10px;">
            <tr><td style="padding:14px 16px;">
              <div class="mono muted" style="font-family:${MONO_S};font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:${T.muted};">${esc(s.label)}</div>
              <div class="mono ink" style="font-family:${MONO_S};font-size:20px;font-weight:700;color:${T.ink};padding-top:4px;">${esc(s.value)}</div>
            </td></tr>
          </table>
        </td>`;
  const [a, c, d] = b.items;
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;">
      <tr>${cell(a, 'right')}${cell(c, 'mid')}${cell(d, 'left')}
      </tr>
    </table>`;
};

// The signature element: every section declares its own state, so the mail is
// scannable without reading a single row.
const blockSection = (b) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:34px;">
      <tr>
        <td class="label ink" style="font-family:${MONO_S};font-size:12px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${T.ink};padding-bottom:10px;">${esc(b.label)}</td>
        <td align="right" style="padding-bottom:10px;">${b.pill ? pillHtml(b.pill) : ''}</td>
      </tr>
      ${RULE_ROW}
    </table>`;

const blockText = (b) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td class="muted" style="padding:16px 0 0 0;font-size:15px;color:${T.muted};">
        ${esc(b.body)}
      </td></tr>
    </table>`;

// Says what happened AND what to do next — never "an error occurred".
const blockCallout = (b) => {
  const c = PILL[b.status] || PILL.neutral;
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;">
      <tr>
        <td width="3" bgcolor="${c.fg}" style="background:${c.fg};border-radius:2px 0 0 2px;font-size:0;line-height:0;">&nbsp;</td>
        <td bgcolor="${c.bg}" style="background:${c.bg};border-radius:0 8px 8px 0;padding:14px 16px;">
          <div class="mono" style="font-family:${MONO_S};font-size:13px;font-weight:700;color:${c.fg};">${esc(b.title)}</div>
          <div style="font-size:14px;line-height:1.55;color:${c.fg};padding-top:3px;">
            ${esc(b.body)}
          </div>
        </td>
      </tr>
    </table>`;
};

const blockLinks = (b) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${b.items.map((it, i) => `${i ? `<tr><td height="1" class="rule" style="height:1px;line-height:1px;font-size:0;background:${T.rule};padding:0;">&nbsp;</td></tr>` : ''}
      <tr><td style="padding:14px 0 0 0;">
        <a href="${safeHref(it.href)}" class="link mono" style="font-family:${MONO_S};font-size:13px;font-weight:700;color:${T.ink};">${esc(it.label)}</a>
        ${it.meta ? `<div class="muted" style="font-size:14px;line-height:1.5;color:${T.muted};padding-top:2px;">${esc(it.meta)}</div>` : ''}
      </td></tr>`).join('')}
    </table>`;

// Real <td> markup, never an ASCII grid in a pre-wrap block — that is what
// makes a digest survive a 375px screen. Three columns max.
const blockTable = (b) => {
  const cols = b.columns.slice(0, 3);
  // Explicit widths keep every row's columns aligned. Without them each cell
  // sizes to its own content and the grid visibly wanders row to row — worse
  // the more rows there are, which is exactly when a table is worth having.
  const widths = Array.isArray(b.widths) && b.widths.length === cols.length ? b.widths : null;
  const w = (i) => (widths ? ` width="${esc(widths[i])}"` : '');
  const head = cols.map((c, i) => `
        <td class="label muted cell"${i ? ' align="right"' : ''}${w(i)} style="font-family:${MONO_S};font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${T.muted};padding:8px 10px;border-bottom:1px solid ${T.rule};">${esc(c)}</td>`).join('');
  const body = b.rows.map((row) => `
      <tr>${row.slice(0, 3).map((cell, i) => {
        const o = typeof cell === 'string' ? { text: cell } : cell;
        const align = i ? ' align="right"' : '';
        const inner = o.pill
          ? `${pillHtml(o.pill)}${o.meta ? `<div class="muted hide-sm" style="font-size:12px;color:${T.muted};padding-top:4px;">${esc(o.meta)}</div>` : ''}`
          : esc(o.text);
        const style = o.pill
          ? `padding:11px 10px;border-bottom:1px solid ${T.rule};`
          : `font-family:${MONO_S};font-size:13px;color:${i ? T.muted : T.ink};padding:11px 10px;border-bottom:1px solid ${T.rule};word-break:break-word;`;
        return `
        <td class="cell${o.pill ? '' : ` mono ${i ? 'muted' : 'ink'}`}"${align}${w(i)} style="${style}">${inner}</td>`;
      }).join('')}
      </tr>`).join('');
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:${b.sublabel ? '20' : '12'}px;">
      ${b.sublabel ? `<tr><td class="label muted" colspan="${cols.length}" style="font-family:${MONO_S};font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${T.muted};padding-bottom:8px;">${esc(b.sublabel)}</td></tr>` : ''}
      <tr>${head}
      </tr>${body}
    </table>`;
};

// Raw output only. Anything with rows and columns belongs in a DATA TABLE.
// word-break stops long paths and datastore names blowing out the layout.
const blockMono = (b) => `
    <div class="mono-blk wash" style="font-family:${MONO};font-size:12.5px;line-height:1.65;color:${T.ink};background:${T.wash};border:1px solid ${T.rule};border-radius:10px;padding:16px 18px;margin-top:20px;white-space:pre-wrap;word-break:break-word;">${esc(b.content)}</div>`;

// One per email, never two.
const blockButton = (b) => `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;">
      <tr><td bgcolor="${T.ink}" class="btn-wrap" style="background:${T.ink};border-radius:8px;">
        <a href="${safeHref(b.href)}" class="btn mono" style="font-family:${MONO_S};display:inline-block;padding:13px 26px;font-size:13px;font-weight:700;letter-spacing:.3px;color:#ffffff;border-radius:8px;">${esc(b.label)}</a>
      </td></tr>
    </table>`;

const blockSignoff = (b) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:32px;">
      <tr><td height="1" class="rule" style="height:1px;line-height:1px;font-size:0;background:${T.rule};">&nbsp;</td></tr>
      <tr><td class="mono muted" style="font-family:${MONO_S};font-size:11px;letter-spacing:.6px;color:${T.muted};padding-top:14px;">
        ${esc(b.text)}
      </td></tr>
    </table>`;

const RENDERERS = {
  title: blockTitle, stats: blockStats, section: blockSection, text: blockText,
  callout: blockCallout, links: blockLinks, table: blockTable, mono: blockMono,
  button: blockButton, signoff: blockSignoff,
};

// ── document ──────────────────────────────────────────────────────────────

/**
 * @param {EmailDoc} doc
 * @returns {{ subject: string, html: string, text: string }}
 */
// Gmail clips messages past ~102KB and appends "View entire message", which cuts
// a digest in half at an arbitrary point. Budget the body so the finished
// document lands under that, and say what was dropped — a silent truncation
// reads as "that was everything" when it means "we stopped".
const BODY_BUDGET = 88_000;

// Slot the plain lane's pre-rendered body drops into. Never appears in output:
// renderEmail always has blocks, renderPlain always replaces it.
const RAW_BODY_MARKER = '<!--TGWAB_BODY-->';

export function renderEmail(doc) {
  const { brand } = doc;
  const parts = [];
  let used = 0;
  let dropped = 0;
  for (const b of doc.blocks) {
    const r = RENDERERS[b.type];
    if (!r) continue;
    const chunk = r(b);
    if (used + chunk.length > BODY_BUDGET) { dropped++; continue; }
    parts.push(chunk);
    used += chunk.length;
  }
  if (dropped) {
    parts.push(blockCallout({
      status: 'warn',
      title: 'Message truncated',
      body: `${dropped} block${dropped === 1 ? '' : 's'} omitted to stay under the ~100KB `
        + 'limit Gmail clips at. Narrow the report, or split it across messages.',
    }));
  }
  const body = parts.length ? parts.join('\n') : RAW_BODY_MARKER;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(doc.subject)}</title>
<style>
  /* Layout classes are only used by these two queries. Everything visual is inline. */
  @media only screen and (max-width:600px) {
    .wrap     { padding:16px !important; }
    .card     { padding:28px 20px !important; border-radius:12px !important; }
    .h1       { font-size:22px !important; letter-spacing:-.4px !important; }
    .stack    { display:block !important; width:100% !important; }
    .stack-pad{ padding:0 0 12px 0 !important; }
    .cell     { padding:9px 8px !important; font-size:12px !important; }
    .mono-blk { font-size:12px !important; padding:14px !important; }
    .btn      { display:block !important; text-align:center !important; }
    .hide-sm  { display:none !important; }
    .foot-pad { padding:20px 21px 0 21px !important; }
  }

  @media (prefers-color-scheme: dark) {
    body, .page      { background:#0c0d0f !important; }
    .card            { background:#16181c !important; border-color:#292d33 !important; }
    .ink, .h1, .h2   { color:#f2f4f7 !important; }
    .muted           { color:#9aa3ad !important; }
    .rule            { border-color:#292d33 !important; background:#292d33 !important; }
    .wash            { background:#1d2025 !important; }
    .cell            { border-color:#292d33 !important; color:#d6dae0 !important; }
    .btn, .btn-wrap  { background:#f2f4f7 !important; color:#14161a !important; }
    .link            { color:#8ab4f8 !important; }
    /* mono block carries its own color inline — must be flipped explicitly */
    .mono-blk        { background:#1d2025 !important; border-color:#31363d !important; color:#e4e8ee !important; }
  }

  a { text-decoration:none; }
  a:hover { text-decoration:underline; }
  /* Collapse is right for the data tables (clean shared 1px hairlines).
     Any cell that has a border AND a border-radius must override this with
     border-collapse:separate;border-spacing:0; or the corner will square off. */
  table { border-collapse:collapse; }
  img { border:0; outline:none; -ms-interpolation-mode:bicubic; }
</style>
<!--[if mso]>
<style>
  * { font-family: Arial, Helvetica, sans-serif !important; }
  .mono, .mono-blk, .h1, .h2, .label { font-family: Consolas, 'Courier New', monospace !important; }
</style>
<![endif]-->
</head>

<body class="page" style="margin:0;padding:0;width:100%;background:${T.page};color:${T.ink};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased;">

<!-- PREHEADER — first ~90 chars shown in the inbox list. Always set it. -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;">
  ${esc(doc.preheader)}
  &#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${T.page}" class="page" style="background:${T.page};">
<tr><td align="center" class="wrap" style="padding:32px 24px;">

<!-- border-collapse MUST be separate here: the card cell has both a border and a
     border-radius, and collapsed tables ignore radius on borders (bg still clips,
     border draws square = doubled corner). Data tables below stay collapsed. -->
<table role="presentation" width="900" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:900px;border-collapse:separate;border-spacing:0;">

  <tr><td style="padding:0 4px 18px 4px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td align="left" valign="middle">
        <img src="${safeHref(brand.logoUrl)}" width="26" height="26" alt="${esc(brand.name)}"
             style="width:26px;height:26px;border-radius:6px;vertical-align:middle;">
        <span class="mono ink" style="font-family:${MONO};font-size:14px;font-weight:700;letter-spacing:-.2px;color:${T.ink};vertical-align:middle;padding-left:9px;">
          ${esc(brand.name)}<span style="color:${esc(brand.accent)};">.</span>
        </span>
      </td>
    </tr></table>
  </td></tr>

  <tr><td bgcolor="${T.card}" class="card" style="background:${T.card};border-radius:16px;border:1px solid ${T.rule};padding:40px 36px;">

    <!-- accent hairline: the only place the brand color appears -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td height="3" style="height:3px;line-height:3px;font-size:0;background:${esc(brand.accent)};width:44px;">&nbsp;</td>
      <td height="3" style="height:3px;line-height:3px;font-size:0;">&nbsp;</td>
    </tr></table>
${body}

  </td></tr>

  <!-- 37px = the card's 36px inner padding + its 1px border, so the footer lines
       up with the body copy above instead of running to the bleed edge. -->
  <tr><td class="foot-pad" style="padding:22px 37px 0 37px;">
    <div class="muted" style="font-size:13px;line-height:1.65;color:${T.muted};">
      ${esc(brand.footerNotice)}
    </div>
    <div class="muted" style="font-size:13px;line-height:1.65;color:${T.muted};padding-top:12px;">
      ${esc(brand.footerLegal)}${brand.unsubscribeUrl
        ? `&nbsp;·&nbsp; <a href="${safeHref(brand.unsubscribeUrl)}" class="link" style="color:${T.muted};text-decoration:underline;">Unsubscribe</a>`
        : ''}
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject: doc.subject, html, text: renderText(doc) };
}

/**
 * The same chrome around a pre-rendered body, for the plain `message` lane.
 *
 * `bodyHtml` is inserted verbatim and MUST already be escaped — the only caller
 * is the mailer's reportHtml(), which escapes every line it emits. Nothing that
 * takes user input should reach this; that is what renderEmail's Block[] is for.
 *
 * This exists so the seventeen ~/bin reports that send plain text get the house
 * template without each one being rewritten into blocks. Their bodies are
 * already structured — reportHtml turns pipe tables into real tables and `━━`
 * headings into headings — so what they were missing was the chrome, not the
 * markup.
 *
 * @param {Brand} brand
 * @param {{subject:string,preheader:string,bodyHtml:string}} o
 */
export function renderPlain(brand, { subject, preheader, bodyHtml }) {
  return renderEmail({ brand, subject, preheader, blocks: [] })
    .html.replace(RAW_BODY_MARKER, bodyHtml);
}

// ── plain text ────────────────────────────────────────────────────────────
// Generated from the same Block[], never by stripping tags. A missing text part
// hurts deliverability and makes the message unreadable in text-only clients
// and most watch notifications.

const WRAP = 78;

function wrap(s, width = WRAP) {
  const out = [];
  for (const para of String(s ?? '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && (line + ' ' + word).length > width) { out.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** @param {EmailDoc} doc */
export function renderText(doc) {
  const L = [doc.preheader, ''];
  for (const b of doc.blocks) {
    switch (b.type) {
      case 'title':
        if (b.eyebrow) L.push(b.eyebrow.toUpperCase());
        L.push(b.heading, '');
        if (b.lede) L.push(wrap(b.lede), '');
        break;
      case 'stats':
        L.push(b.items.map((s) => `${s.label}: ${s.value}`).join('  ·  '), '');
        break;
      case 'section':
        L.push(`## ${b.label.toUpperCase()}${b.pill ? ` — ${b.pill.label.toUpperCase()}` : ''}`, '');
        break;
      case 'text':
        L.push(wrap(b.body), '');
        break;
      case 'callout':
        L.push(`[${b.status.toUpperCase()}] ${b.title}`, wrap(b.body), '');
        break;
      case 'links':
        for (const it of b.items) {
          L.push(`${it.label} — ${it.href}`);
          if (it.meta) L.push(`  ${it.meta}`);
        }
        L.push('');
        break;
      case 'table': {
        if (b.sublabel) L.push(b.sublabel.toUpperCase());
        const cols = b.columns.slice(0, 3);
        const cellText = (c) => {
          const o = typeof c === 'string' ? { text: c } : c;
          return o.pill ? `${o.text ? `${o.text} ` : ''}[${o.pill.label.toUpperCase()}]` : o.text;
        };
        const rows = b.rows.map((r) => r.slice(0, 3).map(cellText));
        const w = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => (r[i] || '').length)));
        L.push(cols.map((c, i) => c.toUpperCase().padEnd(w[i])).join('  ').trimEnd());
        for (const r of rows) L.push(r.map((c, i) => (c || '').padEnd(w[i])).join('  ').trimEnd());
        L.push('');
        break;
      }
      case 'mono':
        L.push(b.content, '');
        break;
      case 'button':
        L.push(`${b.label} — ${b.href}`, '');
        break;
      case 'signoff':
        L.push('—'.repeat(3), b.text, '');
        break;
    }
  }
  L.push('', doc.brand.footerNotice, doc.brand.footerLegal);
  if (doc.brand.unsubscribeUrl) L.push(`Unsubscribe: ${doc.brand.unsubscribeUrl}`);
  return L.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
