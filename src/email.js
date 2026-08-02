// renderEmail — the §9 interface. Chrome is a template, body is a renderer.
//
// {{SUBJECT}}, {{PREHEADER}}, {{BRAND_NAME}}, {{LOGO_URL}}, {{ACCENT}}, {{FOOTER}}
// are string replacement. {{BODY}} is NOT — it is the output of walking the
// markdown AST. Implementing {{BODY}} as .replace() on converted HTML is the
// failure this split exists to prevent.

import { LAYOUT } from './layout.html.js';
import { renderMarkdownBody, esc, MarkdownError } from './markdown.js';

export { MarkdownError };

/**
 * @typedef {{name:string,logoUrl:string,accent:string,footerNotice:string,
 *            footerPostal:string,unsubscribeUrl?:string}} Brand
 * @typedef {{brand:Brand,subject:string,preheader:string,markdown:string,
 *            signoff?:string,eyebrow?:string}} Message
 */

const MONO_S = "'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace";

function footerHtml(brand) {
  // The layout carries no unsubscribe link by default: for ops mail and
  // genuinely transactional product mail the List-Unsubscribe header is the
  // correct mechanism, and Gmail/Outlook surface their own affordance from it.
  // A product that sends anything recurring and non-transactional sets
  // unsubscribeUrl, and the link appears. The layout does not decide; the brand
  // config does.
  const link = brand.unsubscribeUrl
    ? `&nbsp;·&nbsp; <a href="${esc(brand.unsubscribeUrl)}" class="link" style="color:#5b636e;text-decoration:underline;">Unsubscribe</a>`
    : '';
  return `<div class="muted" style="font-size:13px;line-height:1.65;color:#5b636e;">
        ${esc(brand.footerNotice)}
      </div>
      <div class="muted" style="font-size:13px;line-height:1.65;color:#5b636e;padding-top:12px;">
        ${esc(brand.footerPostal)}${link}
      </div>`;
}

const signoffHtml = (text) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:30px;">
      <tr><td height="1" class="rule" style="height:1px;line-height:1px;font-size:0;background:#dfe3e8;">&nbsp;</td></tr>
      <tr><td class="mono muted" style="font-family:${MONO_S};font-size:11px;letter-spacing:.6px;color:#5b636e;padding-top:14px;">${esc(text)}</td></tr>
    </table>`;

/** @param {Message} msg */
export function renderEmail(msg) {
  const { brand } = msg;
  let body = renderMarkdownBody(msg.markdown, { eyebrow: msg.eyebrow });
  if (msg.signoff) body += `\n\n    ${signoffHtml(msg.signoff)}`;

  const html = LAYOUT
    .replace('{{BODY}}', () => body)          // function form: no $& / $1 expansion
    .replace(/\{\{SUBJECT\}\}/g, () => esc(msg.subject))
    .replace(/\{\{PREHEADER\}\}/g, () => esc(msg.preheader))
    .replace(/\{\{BRAND_NAME\}\}/g, () => esc(brand.name))
    .replace(/\{\{LOGO_URL\}\}/g, () => esc(brand.logoUrl))
    .replace(/\{\{ACCENT\}\}/g, () => esc(brand.accent))
    .replace(/\{\{FOOTER\}\}/g, () => footerHtml(brand))
    .replace(/\{\{TOKENS\}\}/g, '');

  // §13: worst case under 100KB. Gmail clips past ~102KB and appends "View
  // entire message", cutting a notification at an arbitrary point. Throwing
  // rather than truncating is deliberate — if a message is this big, the detail
  // belongs in the artifact (§1), and the author should be told, not the reader.
  if (html.length > 100_000) {
    throw new MarkdownError(
      `rendered message is ${html.length} bytes (limit 100000) — move the detail to an artifact and link it`,
    );
  }

  return { subject: msg.subject, html, text: renderText(msg) };
}

// ── §10 plain text ────────────────────────────────────────────────────────
// The markdown source IS the text part. Only these normalizations are applied;
// anything more creates a second artifact that drifts from the source.

const WRAP = 78;

/** @param {Message} msg */
export function renderText(msg) {
  const src = String(msg.markdown ?? '')
    .replace(/\{ok\}/g, ' [OK]')
    .replace(/\{warn\}/g, ' [WARN]')
    .replace(/\{bad\}/g, ' [BAD]')
    .replace(/\{btn\}/g, '');

  const out = [];
  let inFence = false;
  for (const line of src.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; out.push(line); continue; }
    // Fences and tables keep their own alignment — wrapping either destroys the
    // one property that makes the text part readable unrendered.
    if (inFence || /^\s*\|/.test(line) || line.length <= WRAP) { out.push(line); continue; }
    let cur = '';
    for (const w of line.split(/\s+/)) {
      if (cur && (cur + ' ' + w).length > WRAP) { out.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
    }
    if (cur) out.push(cur);
  }
  const tail = msg.signoff ? `\n\n${msg.signoff}` : '';
  return `${msg.preheader}\n\n${out.join('\n').trim()}${tail}\n\n${msg.brand.footerNotice}\n${msg.brand.footerPostal}\n`;
}
