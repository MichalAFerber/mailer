// Markdown in, template components out.
//
// Scripts author markdown. The mailer parses it to an AST and walks it, emitting
// the components in tgwab-standards/templates/tgwab-email-layout.html. It never
// pastes a markdown converter's HTML into the layout — that route produces
// unclassed markup with no dark-mode counterpart and an injection surface, and
// it is exactly how the 2026-08-02 Pages notification shipped unreadable.
//
// The markdown source IS the text/plain part, verbatim. That is the argument for
// markdown as the wire format: every other approach makes the text part a second
// artifact that has to be kept correct, and it drifts.
//
// Conventions borrowed from syntax people already know, both of which stay
// readable unrendered — the test any convention here has to pass:
//   ## Heading {ok|warn|bad}   pill on a section header
//   > [!WARNING] Title         GitHub alert → callout
//   [label](url){btn}          button (one per email)

import MarkdownIt from 'markdown-it';

const MONO = "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const MONO_S = "'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace";
const T = { ink: '#14161a', muted: '#5b636e', rule: '#dfe3e8', wash: '#f5f6f8' };

// Status vocabulary is closed on purpose. Let scripts pass arbitrary pill text
// and you get eleven synonyms for "broken": status is the pill, detail is the row.
const PILL = {
  ok: { fg: '#0f6b47', bg: '#e3f2ea' },
  warn: { fg: '#8a5a00', bg: '#fbf1dc' },
  bad: { fg: '#a4231f', bg: '#fbe6e4' },
};
const ALERT_STATUS = { NOTE: 'ok', TIP: 'ok', IMPORTANT: 'warn', WARNING: 'warn', CAUTION: 'bad' };

const MAX_COLS = 3;

// Structural tokens consumed by their block handlers; seeing one at top level is
// expected and not an unhandled construct.
const IGNORED = new Set([
  'heading_close', 'paragraph_close', 'blockquote_close', 'inline', 'text',
  'bullet_list_close', 'ordered_list_close', 'list_item_open', 'list_item_close',
  'table_close', 'thead_open', 'thead_close', 'tbody_open', 'tbody_close',
  'tr_open', 'tr_close', 'th_open', 'th_close', 'td_open', 'td_close',
]);

export class MarkdownError extends Error {}

// Footer notices name the sending address in prose. Whether that address became
// a link used to depend on the READER'S mail client: auto-linkers wrap addresses
// at display time, and their TLD lists are often old enough to know .us but not
// .app — so textwizard.us got a mailto and resizewizard.app did not, from
// byte-identical templates. Emitting the anchor ourselves makes it deterministic
// (clients do not double-link an existing anchor) and keeps it under the .link
// dark-mode styling instead of the client's default blue.
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export function escWithMailto(s, color = '#5b636e') {
  // Escape FIRST. An address contains none of the five HTML-significant
  // characters, so escaping cannot corrupt the match.
  return esc(s).replace(EMAIL_IN_TEXT, (addr) =>
    `<a href="mailto:${addr}" class="link" style="color:${color};text-decoration:underline;">${addr}</a>`);
}

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// §9: throw rather than neutralise. A '#' link in a notification is a dead end
// the reader discovers by clicking; a throw is discovered by the author.
function safeHref(h) {
  const v = String(h ?? '');
  if (!/^https:\/\//i.test(v)) {
    throw new MarkdownError(`link must be absolute https, got "${v}"`);
  }
  return esc(v);
}

// html:false escapes raw HTML as a config flag rather than something a rule has
// to remember to override.
const md = new MarkdownIt({ html: false, linkify: false, breaks: false });

const pill = (label, status) => {
  const c = PILL[status];
  return `<span class="mono" style="font-family:${MONO_S};display:inline-block;padding:3px 9px;`
    + `border-radius:999px;background:${c.bg};color:${c.fg};font-size:10px;font-weight:700;`
    + `letter-spacing:.8px;text-transform:uppercase;">${esc(label)}</span>`;
};

/** Inline children → styled inline HTML. Never raw passthrough. */
function inline(tokens, ctx) {
  let out = '';
  for (const t of tokens || []) {
    switch (t.type) {
      case 'text': out += esc(t.content); break;
      case 'code_inline':
        out += `<span class="mono mono-in" style="font-family:${MONO_S};font-size:13px;background:${T.wash};padding:1px 5px;border-radius:4px;">${esc(t.content)}</span>`;
        break;
      case 'strong_open': out += '<strong>'; break;
      case 'strong_close': out += '</strong>'; break;
      case 'em_open': out += '<em>'; break;
      case 'em_close': out += '</em>'; break;
      case 'softbreak': out += ' '; break;
      case 'hardbreak': out += '<br>'; break;
      case 'link_open': {
        const href = t.attrGet('href');
        ctx.pendingHref = href;
        out += `<a href="${safeHref(href)}" class="link" style="color:${T.ink};font-weight:600;text-decoration:underline;">`;
        break;
      }
      case 'link_close': out += '</a>'; break;
      // §9 applies inline too: an unhandled inline token would otherwise be
      // swallowed or emitted unclassed. `image` lands here deliberately — a
      // remote image is blocked by default in Gmail and Outlook, so it belongs
      // in the artifact, not the notification.
      default:
        throw new MarkdownError(`unhandled inline token "${t.type}" — not a component in the catalog`);
    }
  }
  return out;
}

/**
 * @param {string} source markdown
 * @param {{eyebrow?: string}} [opts] eyebrow is the job/product label above the H1;
 *   it is not in the markdown because it belongs to the sender, not the message.
 * @returns {string} component HTML for the {{BODY}} slot
 */
export function renderMarkdownBody(source, opts = {}) {
  const tokens = md.parse(String(source ?? ''), {});
  const out = [];
  const ctx = {};
  let i = 0;
  let sawH1 = false;
  let buttons = 0;

  while (i < tokens.length) {
    const t = tokens[i];

    // ── TITLE / SECTION HEADER ──────────────────────────────────────────
    if (t.type === 'heading_open') {
      const body = tokens[i + 1];
      const raw = body?.content ?? '';
      if (t.tag === 'h1') {
        if (sawH1) throw new MarkdownError('more than one H1: a notification has one title');
        sawH1 = true;
        const eyebrow = opts.eyebrow
          ? `<tr><td class="label muted" style="font-family:${MONO_S};font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${T.muted};padding:22px 0 8px 0;">${esc(opts.eyebrow)}</td></tr>`
          : '';
        out.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${eyebrow}
      <tr><td class="h1 ink" style="font-family:${MONO};font-size:27px;font-weight:700;letter-spacing:-.8px;line-height:1.25;color:${T.ink};">${esc(raw)}</td></tr>
    </table>`);
      } else {
        const m = raw.match(/^(.*?)\s*\{(ok|warn|bad)\}\s*$/);
        if (!m && /\{[^}]*\}\s*$/.test(raw)) {
          throw new MarkdownError(`unknown pill status in "${raw}" — only {ok}, {warn}, {bad}`);
        }
        const label = m ? m[1] : raw;
        const badge = m ? pill(m[2] === 'ok' ? 'ok' : m[2] === 'warn' ? 'warn' : 'bad', m[2]) : '';
        out.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:32px;">
      <tr>
        <td class="label ink" style="font-family:${MONO_S};font-size:12px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${T.ink};padding-bottom:10px;">${esc(label)}</td>
        ${badge ? `<td align="right" style="padding-bottom:10px;">${badge}</td>` : ''}
      </tr>
      <tr><td${badge ? ' colspan="2"' : ''} height="1" class="rule" style="height:1px;line-height:1px;font-size:0;background:${T.rule};">&nbsp;</td></tr>
    </table>`);
      }
      i += 3;
      continue;
    }

    // ── CALLOUT (GitHub alert) or TEXT ──────────────────────────────────
    if (t.type === 'blockquote_open') {
      const inner = [];
      let d = 1;
      let j = i + 1;
      while (j < tokens.length && d > 0) {
        if (tokens[j].type === 'blockquote_open') d++;
        if (tokens[j].type === 'blockquote_close') d--;
        if (d > 0) inner.push(tokens[j]);
        j++;
      }
      const first = inner.find((x) => x.type === 'inline');
      const m = first?.content.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/s);
      if (m) {
        const status = ALERT_STATUS[m[1]];
        const c = PILL[status];
        const [title, ...rest] = m[2].split('\n');
        const bodyText = rest.join(' ').trim()
          || inner.filter((x) => x.type === 'inline').slice(1).map((x) => x.content).join(' ');
        out.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;">
      <tr>
        <td width="3" bgcolor="${c.fg}" style="background:${c.fg};border-radius:2px 0 0 2px;font-size:0;line-height:0;">&nbsp;</td>
        <td bgcolor="${c.bg}" style="background:${c.bg};border-radius:0 8px 8px 0;padding:14px 16px;">
          <div class="mono" style="font-family:${MONO_S};font-size:13px;font-weight:700;color:${c.fg};">${esc(title.trim())}</div>
          ${bodyText ? `<div style="font-size:14px;line-height:1.55;color:${c.fg};padding-top:3px;">${esc(bodyText)}</div>` : ''}
        </td>
      </tr>
    </table>`);
        i = j;
        continue;
      }
      i = j;
      continue;
    }

    // ── TEXT ────────────────────────────────────────────────────────────
    if (t.type === 'paragraph_open') {
      const body = tokens[i + 1];
      const only = body?.children?.filter((c) => c.type !== 'text' || c.content.trim());
      // [label](url){btn} on its own line is a BUTTON, not a paragraph.
      const btn = body?.content.match(/^\[([^\]]+)\]\(([^)]+)\)\{btn\}$/);
      if (btn) {
        if (++buttons > 1) throw new MarkdownError('more than one {btn}: one primary action per email');
        out.push(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:26px;">
      <tr><td bgcolor="${T.ink}" class="btn-wrap" style="background:${T.ink};border-radius:8px;">
        <a href="${safeHref(btn[2])}" class="btn mono" style="font-family:${MONO_S};display:inline-block;padding:13px 26px;font-size:13px;font-weight:700;letter-spacing:.3px;color:#ffffff;border-radius:8px;">${esc(btn[1])}</a>
      </td></tr>
    </table>`);
      } else if (only?.length) {
        out.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td class="ink" style="font-size:15px;line-height:1.65;color:${T.ink};padding:16px 0 0 0;">${inline(body.children, ctx)}</td></tr>
    </table>`);
      }
      i += 3;
      continue;
    }

    // ── MONO BLOCK ──────────────────────────────────────────────────────
    if (t.type === 'fence' || t.type === 'code_block') {
      out.push(`<div class="mono-blk wash" style="font-family:${MONO};font-size:12.5px;line-height:1.65;color:${T.ink};background:${T.wash};border:1px solid ${T.rule};border-radius:10px;padding:16px 18px;margin-top:18px;white-space:pre-wrap;word-break:break-word;">${esc(t.content.replace(/\n$/, ''))}</div>`);
      i++;
      continue;
    }

    // ── LIST ────────────────────────────────────────────────────────────
    if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') {
      const tag = t.type.startsWith('ordered') ? 'ol' : 'ul';
      const items = [];
      let d = 1;
      let j = i + 1;
      while (j < tokens.length && d > 0) {
        if (tokens[j].type.endsWith('_list_open')) d++;
        if (tokens[j].type.endsWith('_list_close')) d--;
        if (d > 0 && tokens[j].type === 'inline') items.push(inline(tokens[j].children, ctx));
        j++;
      }
      out.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td style="padding:12px 0 0 0;">
        <${tag} style="margin:0;padding:0 0 0 22px;">
          ${items.map((it, n) => `<li class="li ink" style="font-size:15px;line-height:1.6;color:${T.ink};${n < items.length - 1 ? 'padding-bottom:6px;' : ''}">${it}</li>`).join('\n          ')}
        </${tag}>
      </td></tr>
    </table>`);
      i = j;
      continue;
    }

    // ── DATA TABLE ──────────────────────────────────────────────────────
    if (t.type === 'table_open') {
      const rows = [];
      let cur = null;
      let j = i + 1;
      let inHead = false;
      while (j < tokens.length && tokens[j].type !== 'table_close') {
        const x = tokens[j];
        if (x.type === 'thead_open') inHead = true;
        if (x.type === 'thead_close') inHead = false;
        if (x.type === 'tr_open') cur = { head: inHead, cells: [] };
        if (x.type === 'inline') cur?.cells.push(x);
        if (x.type === 'tr_close' && cur) { rows.push(cur); cur = null; }
        j++;
      }
      const head = rows.find((r) => r.head);
      const cols = head ? head.cells.length : (rows[0]?.cells.length ?? 0);
      if (cols > MAX_COLS) {
        // Hard failure, not a silent degrade. A daily script that throws is cheap;
        // a mangled table in a client notification is not.
        throw new MarkdownError(`table has ${cols} columns, max ${MAX_COLS} — move the detail to the artifact and link it`);
      }
      const th = head
        ? head.cells.map((c, n) => `<td class="label muted cell"${n ? ' align="right"' : ''} style="font-family:${MONO_S};font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${T.muted};padding:8px 10px;border-bottom:1px solid ${T.rule};">${esc(c.content)}</td>`).join('\n        ')
        : '';
      const body = rows.filter((r) => !r.head).map((r) => `<tr>
        ${r.cells.map((c, n) => {
          const txt = c.content.trim();
          const asPill = n === r.cells.length - 1 && n > 0 && PILL[txt.toLowerCase()] ? txt.toLowerCase() : null;
          if (asPill) {
            return `<td class="cell" align="right" style="padding:11px 10px;border-bottom:1px solid ${T.rule};">${pill(txt, asPill)}</td>`;
          }
          return `<td class="cell mono ${n ? 'muted' : 'ink'}"${n ? ' align="right"' : ''} style="font-family:${MONO_S};font-size:13px;color:${n ? T.muted : T.ink};padding:11px 10px;border-bottom:1px solid ${T.rule};word-break:break-word;">${inline(c.children, ctx)}</td>`;
        }).join('\n        ')}
      </tr>`).join('\n      ');
      out.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px;">
      ${th ? `<tr>\n        ${th}\n      </tr>` : ''}
      ${body}
    </table>`);
      i = j + 1;
      continue;
    }

    // ── RULE ────────────────────────────────────────────────────────────
    if (t.type === 'hr') {
      out.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
      <tr><td height="1" class="rule" style="height:1px;line-height:1px;font-size:0;background:${T.rule};">&nbsp;</td></tr>
    </table>`);
      i++;
      continue;
    }

    // §9: an unhandled token type throws. Falling through would emit markdown-it's
    // default HTML, which carries no class, so no dark-mode counterpart — the
    // precise mechanism behind the unreadable Pages notification.
    if (!IGNORED.has(t.type)) {
      throw new MarkdownError(`unhandled markdown token "${t.type}" — add a component or remove the construct`);
    }
    i++;
  }

  return out.join('\n\n    ');
}
