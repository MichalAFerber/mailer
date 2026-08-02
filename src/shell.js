// The §6 house email shell (templates/email-shell.html in tgwab-standards),
// vendored for the mailer: every product's mail — contact and send lanes —
// renders inside it. Placeholders are filled from the product's KV projection;
// every interpolated value is escaped by the caller or here.
//
// One adaptation from the template: the logo <img> points at the product's
// /icon-192.png (the §11 manifest icon on the product's OWN domain, per the
// template's absolute-https rule), unless the projection carries an explicit
// icon_url — for products whose domain hosts no site (ops: thompsonblack.us
// 301s to the LLC site, so the mailer serves its own mark). Clients that block
// images show the product-name alt text — the wordmark cell carries the name
// regardless.
import { escapeHtml } from './index.js';

const POSTAL_ADDRESS = 'ThompsonBlack LLC, PO Box 3071, Florence SC 29502';

export function renderShell(product, { heading, preheader, body }) {
  const name = escapeHtml(product.name);
  const domain = escapeHtml(product.domain);
  const sender = escapeHtml(product.from_addr);
  const icon = escapeHtml(product.icon_url || `https://${product.domain}/icon-192.png`);
  const head = escapeHtml(heading);
  const pre = escapeHtml(preheader);
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${head}</title>
<style>
div[style*="margin: 16px 0"] { border: 0 !important;margin: 0 !important;outline: 0 !important;padding: 0 !important;text-decoration: none !important; }
@media screen and (max-width: 767px) {
a.button { display: block !important;text-align: center !important; }
div.wrapper { padding: 24px 16px 24px 16px !important; }
img.logo-image { height: 32px !important;width: 32px !important; }
table.inner { max-width: 100% !important; }
td.content { padding: 40px 24px 40px 24px !important; }
td.footer-notice { padding: 14px 18px 14px 18px !important; }
td.header { padding: 0 0 24px 0 !important; }
td.heading { font-size: 24px !important; }
td.logo-text { font-size: 20px !important;padding-left: 6px !important; }
td.spacer { line-height: 16px !important; }
td.spacer-alt { line-height: 24px !important; }
td.spacer-major { line-height: 16px !important; }
}
</style>
</head>
<body style="background-color: #eeeeee;color: #444444;font-family: Arial, Helvetica, sans-serif;font-size: 16px;font-style: normal;font-weight: 400;letter-spacing: 0px;line-height: 1.5;margin: 0;padding: 0;word-break: break-word;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;visibility:hidden;">${pre}</div>
<div class="wrapper" style="padding: 40px;">
<table class="inner" role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 0 auto;max-width: 640px;width: 100%;">
<tr>
<td class="header" style="padding: 40px 0 40px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr>
<td><img class="logo-image" width="48" height="48" style="border-radius: 100%;height: 48px;vertical-align: middle;width: 48px;" src="${icon}" alt="${name}"></td>
<td class="logo-text" style="font-size: 24px;font-weight: bold;padding-left: 8px;color: #222222;">${name}</td>
</tr>
</table>
</td>
</tr>
<tr>
<td class="content" style="background-color: #ffffff;border-radius: 16px;padding: 48px 40px 48px 40px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
<tr><td class="heading" style="font-size: 28px;font-weight: bold;color: #222222;">${head}</td></tr>
<tr><td class="spacer" style="line-height: 20px;">&nbsp;</td></tr>
<tr><td class="paragraph" style="line-height: 24px;">${body}</td></tr>
<tr><td class="spacer-alt" style="line-height: 32px;">&nbsp;</td></tr>
<tr><td class="signoff" style="font-style: italic;line-height: 24px;">&ndash; ${name}</td></tr>
</table>
</td>
</tr>
<tr><td class="spacer-major" style="line-height: 40px;">&nbsp;</td></tr>
<tr>
<td class="footer-notice" style="border: solid 1px #d0d0d0;border-radius: 16px;font-size: 14px;line-height: 24px;padding: 18px 22px 18px 22px;">This message was sent by ${name} in response to an action on ${domain}. Add <b style="color: #333333;">${sender}</b> to your address book so future messages reach your inbox. If this landed in spam or junk, mark it <b style="color: #333333;">Not Spam</b>.</td>
</tr>
<tr><td class="spacer-major" style="line-height: 40px;">&nbsp;</td></tr>
<tr>
<td class="copyright" style="color: #777777;font-size: 14px;">${escapeHtml(POSTAL_ADDRESS)}</td>
</tr>
</table>
</div>
</body>
</html>`;
}
