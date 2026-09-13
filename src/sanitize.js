// The brand-override lane (mailer#36 Fix B): a white-label product may send its
// own fully assembled HTML document instead of the house layout. This module
// holds the whole trust boundary for that lane: who may use it, what the payload
// must look like, and what survives of the caller's markup.
//
// Sanitizing runs on HTMLRewriter, the streaming parser workerd ships, and never
// on regular expressions. The allow rule mirrors safeHref() in template.js,
// generalized to every URL-bearing attribute: absolute https only.

// Measured in UTF-8 bytes. The HTML cap applies to the SANITIZED output, and an
// oversized document is rejected rather than truncated: truncated HTML is a
// malformed document. 90,000 bytes fits uploadwizard-app's confirmation email,
// whose file list carries a presigned URL of about 614 bytes per file (at 40,000
// it failed from 46 files, where SMTP had delivered), and stays under the ~102KB
// point where Gmail clips a message.
export const BRAND_OVERRIDE_LIMITS = { html_bytes: 90000, text_bytes: 90000 };

const ALLOWED_KEYS = new Set(['html', 'text', 'suppress_platform_wrapper']);

// Dropped with their content. The second row is mutation-XSS routes: a parser
// reads their contents as markup with scripting disabled and as raw text with it
// enabled, so a mail client's own sanitizer can disagree with this one about
// what is inside. The third row is SVG animation, which can set an attribute
// such as href at render time. lol-html reports SVG tag names lowercased
// (`animateTransform` arrives as `animatetransform`), and the match below
// lowercases anyway.
const DROP = new Set([
  'script', 'iframe', 'object', 'embed', 'form', 'base', 'link',
  'noscript', 'noembed', 'noframes', 'template', 'xmp', 'plaintext',
  'animate', 'set', 'animatemotion', 'animatetransform',
]);

const URL_ATTRS = new Set([
  'href', 'src', 'action', 'formaction', 'background', 'poster', 'data', 'xlink:href',
]);

const HTTPS = /^https:\/\//i;

// A tag name the HTML tokenizer accepts but no real element has. `<scr<script>`
// tokenizes as one element named `scr<script`, so its markup passes a tag-name
// check untouched and reaches the output as the literal text `<scr<script>`.
// Every later parser that sees it (a mail client's own sanitizer, a webmail
// preview) is a chance for a differential, so the tags go and the text stays.
// One namespace prefix is allowed because Outlook markup (`<o:p>`) is routine in
// authored email.
const TAG_NAME = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?$/;

const byteLength = (s) => new TextEncoder().encode(s).length;

function srcsetAllowed(value) {
  // A comma inside a URL splits it into a fragment that fails the test, which
  // drops the attribute: strict in the safe direction.
  return value.split(',').every((candidate) => HTTPS.test(candidate.trim()));
}

const sanitizer = {
  element(el) {
    const tag = el.tagName.toLowerCase();
    if (!TAG_NAME.test(tag)) {
      el.removeAndKeepContent();
      return;
    }
    const httpEquiv = (el.getAttribute('http-equiv') || '').trim().toLowerCase();
    if (DROP.has(tag) || (tag === 'meta' && httpEquiv === 'refresh')) {
      el.remove();
      return;
    }
    // Snapshot first: removing an attribute while iterating the live list skips
    // the one after it.
    for (const [rawName, value] of [...el.attributes]) {
      const name = rawName.toLowerCase();
      if (
        name.startsWith('on')
        // A tracking beacon on click, whatever its scheme.
        || name === 'ping'
        || (URL_ATTRS.has(name) && !HTTPS.test(value))
        || (name === 'srcset' && !srcsetAllowed(value))
      ) {
        el.removeAttribute(rawName);
      }
    }
  },
};

export async function sanitizeHtml(html) {
  return new HTMLRewriter().on('*', sanitizer).transform(new Response(html)).text();
}

// Decide the lane for one request. Returns { error } for a 400 bad_payload, or
// { html, text } ready to hand to delivery. Whether a product may use the lane at
// all is a registry decision (white_label, transactional_only), never something
// the request body can grant itself.
export async function prepareBrandOverride(product, override) {
  if (override === null || typeof override !== 'object' || Array.isArray(override)) {
    return { error: 'brand_override must be an object' };
  }
  if (product?.white_label !== true) {
    return { error: 'brand_override is not enabled for this product' };
  }
  const unknown = Object.keys(override).filter((k) => !ALLOWED_KEYS.has(k));
  if (unknown.length) {
    return { error: `brand_override does not accept: ${unknown.join(', ')}` };
  }
  // Only full replacement exists. No caller needs platform chrome around a
  // tenant body, so there is no code path for it.
  if (override.suppress_platform_wrapper !== true) {
    return { error: 'brand_override.suppress_platform_wrapper must be true' };
  }
  // The platform footer carries the postal line CAN-SPAM requires of commercial
  // mail. Only a product registered as transactional-only may omit it.
  if (product.transactional_only !== true) {
    return { error: 'brand_override requires a transactional_only product' };
  }
  if (typeof override.html !== 'string' || !override.html) {
    return { error: 'brand_override.html is required' };
  }
  if (override.text !== undefined && typeof override.text !== 'string') {
    return { error: 'brand_override.text must be a string' };
  }
  const text = override.text || undefined;
  if (text && byteLength(text) > BRAND_OVERRIDE_LIMITS.text_bytes) {
    return { error: `brand_override.text exceeds ${BRAND_OVERRIDE_LIMITS.text_bytes} bytes` };
  }
  const html = await sanitizeHtml(override.html);
  if (byteLength(html) > BRAND_OVERRIDE_LIMITS.html_bytes) {
    return { error: `brand_override.html exceeds ${BRAND_OVERRIDE_LIMITS.html_bytes} bytes after sanitizing` };
  }
  return { html, text };
}

// Run every fixture and every gate rule through the real code in whatever
// runtime this is. A guard reads 'stripped' only when its detector matched the
// input, missed the output, and the output kept its benign content.
export async function selftestBrandOverride() {
  if (typeof HTMLRewriter !== 'function') return { available: false };
  const guards = {};
  for (const f of SANITIZER_FIXTURES) {
    if (!f.absent.test(f.html)) {
      guards[f.name] = 'detector does not match its input';
      continue;
    }
    const out = await sanitizeHtml(f.html);
    if (f.absent.test(out)) guards[f.name] = 'SURVIVED';
    else if (f.present && !f.present.test(out)) guards[f.name] = 'benign content lost';
    else guards[f.name] = 'stripped';
  }
  const payload = { html: '<p>ok</p>', text: 'ok', suppress_platform_wrapper: true };
  const flagged = { white_label: true, transactional_only: true };
  const rejects = async (product, override) => Boolean((await prepareBrandOverride(product, override)).error);
  const big = 'a'.repeat(BRAND_OVERRIDE_LIMITS.html_bytes);
  const gate = {
    accepts_flagged_product: !(await rejects(flagged, payload)),
    rejects_without_white_label: await rejects({ transactional_only: true }, payload),
    rejects_without_transactional_only: await rejects({ white_label: true }, payload),
    rejects_unsuppressed_wrapper: await rejects(flagged, { ...payload, suppress_platform_wrapper: false }),
    rejects_oversized_output: await rejects(flagged, { ...payload, html: `<p>${big}</p>` }),
    caps_output_not_input: !(await rejects(flagged, { ...payload, html: `<p>ok</p><script>${big}</script>` })),
    rejects_oversized_text: await rejects(flagged, { ...payload, text: 'a'.repeat(BRAND_OVERRIDE_LIMITS.text_bytes + 1) }),
  };
  const ok = Object.values(guards).every((v) => v === 'stripped') && Object.values(gate).every(Boolean);
  return { available: true, ok, guards, gate };
}

// Hostile inputs, shared by the unit tests and /selftest so the two cannot
// drift. `absent` must match the raw input (the detector is armed) and must not
// match the sanitized output. `present`, where given, must match the output, so
// a sanitizer that returns an empty string cannot pass.
export const SANITIZER_FIXTURES = [
  { name: 'script', html: '<p>hi</p><script>alert(1)</script>', absent: /<script/i, present: /<p>hi<\/p>/ },
  { name: 'script_uppercase', html: '<p>hi</p><SCRIPT>alert(1)</SCRIPT>', absent: /<script|alert/i, present: /<p>hi<\/p>/ },
  { name: 'script_malformed_nesting', html: '<p>hi</p><scr<script>ipt>alert(1)</script>', absent: /<script/i, present: /<p>hi<\/p>/ },
  { name: 'script_double_open', html: '<p>hi</p><<script>script>alert(1)<</script>/script>', absent: /<script/i, present: /<p>hi<\/p>/ },
  { name: 'script_in_svg', html: '<p>hi</p><svg><script>alert(1)</script></svg>', absent: /<script|alert/i, present: /<p>hi<\/p>/ },
  { name: 'iframe', html: '<p>hi</p><IFRAME src="https://evil.test"></IFRAME>', absent: /<iframe|evil\.test/i, present: /<p>hi<\/p>/ },
  { name: 'object', html: '<p>hi</p><object data="https://evil.test/x.swf"></object>', absent: /<object|evil\.test/i, present: /<p>hi<\/p>/ },
  { name: 'embed', html: '<p>hi</p><embed src="https://evil.test/x.swf">', absent: /<embed|evil\.test/i, present: /<p>hi<\/p>/ },
  { name: 'form', html: '<p>hi</p><form action="https://evil.test"><input name="pw"></form>', absent: /<form|<input|evil\.test/i, present: /<p>hi<\/p>/ },
  { name: 'base', html: '<base href="https://evil.test/"><p>hi</p>', absent: /<base|evil\.test/i, present: /<p>hi<\/p>/ },
  { name: 'link', html: '<LINK rel="stylesheet" href="https://evil.test/x.css"><p>hi</p>', absent: /<link|evil\.test/i, present: /<p>hi<\/p>/ },
  { name: 'meta_refresh', html: '<META HTTP-EQUIV="Refresh" content="0;url=https://evil.test"><meta charset="utf-8"><p>hi</p>', absent: /refresh|evil\.test/i, present: /<meta charset="utf-8">/ },
  { name: 'on_attribute', html: '<a href="https://ok.test/p" onclick="steal()">go</a>', absent: /onclick|steal/i, present: /href="https:\/\/ok\.test\/p"/ },
  { name: 'on_attribute_uppercase', html: '<IMG SRC="https://ok.test/i.png" ONERROR="steal()">', absent: /onerror|steal/i, present: /https:\/\/ok\.test\/i\.png/ },
  { name: 'javascript_href', html: '<a href="javascript:alert(1)">go</a>', absent: /javascript:/i, present: />go</ },
  { name: 'javascript_href_mixed_case', html: '<A HREF="JaVaScRiPt:alert(1)">go</A>', absent: /javascript:/i, present: />go</ },
  { name: 'data_src', html: '<img src="data:image/svg+xml;base64,PHN2Zz4=" alt="x">', absent: /data:/i, present: /alt="x"/ },
  { name: 'http_src', html: '<img src="http://evil.test/p.png" alt="x">', absent: /evil\.test/i, present: /alt="x"/ },
  { name: 'protocol_relative_href', html: '<a href="//evil.test/p">go</a>', absent: /evil\.test/i, present: />go</ },
  { name: 'srcset_candidate', html: '<img srcset="https://ok.test/a.png 1x, http://evil.test/b.png 2x" alt="x">', absent: /evil\.test/i, present: /alt="x"/ },
  { name: 'formaction', html: '<button formaction="javascript:steal()">go</button>', absent: /javascript:/i, present: />go</ },
  { name: 'background', html: '<table><tr><td background="http://evil.test/bg.png">x</td></tr></table>', absent: /evil\.test/i, present: /<td>x<\/td>/ },
  { name: 'poster', html: '<video poster="javascript:steal()"></video><p>hi</p>', absent: /javascript:/i, present: /<p>hi<\/p>/ },
  { name: 'xlink_href', html: '<svg><a xlink:href="javascript:steal()"><text>go</text></a></svg>', absent: /javascript:/i, present: /<text>go<\/text>/ },
  // Mutation XSS: these elements' contents are markup to one parser and raw text
  // to another, depending on whether scripting is enabled. A webmail client's own
  // sanitizer can read the payload in the attribute as a live element. The
  // `onerror` half is already stripped by the on* rule, so the element's own tag
  // is what proves the drop.
  { name: 'noscript_mxss', html: '<p>hi</p><noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>', absent: /<noscript|onerror/i, present: /<p>hi<\/p>/ },
  { name: 'noembed_mxss', html: '<p>hi</p><NOEMBED><p title="</noembed><img src=x onerror=alert(1)>"></NOEMBED>', absent: /<noembed|onerror/i, present: /<p>hi<\/p>/ },
  { name: 'noframes_mxss', html: '<p>hi</p><noframes><p title="</noframes><img src=x onerror=alert(1)>"></noframes>', absent: /<noframes|onerror/i, present: /<p>hi<\/p>/ },
  { name: 'template', html: '<p>hi</p><template><img src="https://ok.test/i.png" onerror="alert(1)"></template>', absent: /<template|<img|onerror/i, present: /<p>hi<\/p>/ },
  { name: 'xmp_mxss', html: '<p>hi</p><xmp><p title="</xmp><img src=x onerror=alert(1)>"></xmp>', absent: /<xmp|onerror/i, present: /<p>hi<\/p>/ },
  { name: 'plaintext', html: '<p>hi</p><plaintext><img src=x onerror=alert(1)>', absent: /<plaintext|onerror/i, present: /<p>hi<\/p>/ },
  // SVG animation can set an attribute at render time, after any static check.
  { name: 'svg_animate', html: '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>go</text></a></svg>', absent: /<animate|javascript:/i, present: /<text>go<\/text>/ },
  { name: 'svg_set_uppercase', html: '<svg><a><SET attributeName="href" to="javascript:alert(1)"></SET><text>go</text></a></svg>', absent: /<set|javascript:/i, present: /<text>go<\/text>/ },
  { name: 'svg_animatemotion', html: '<svg><animateMotion path="M0,0" dur="1s"/><text>go</text></svg>', absent: /<animatemotion/i, present: /<text>go<\/text>/ },
  { name: 'svg_animatetransform', html: '<svg><a><animateTransform attributeName="href" to="javascript:alert(1)"/><text>go</text></a></svg>', absent: /<animatetransform|javascript:/i, present: /<text>go<\/text>/ },
  { name: 'ping', html: '<a href="https://ok.test/p" ping="https://track.test/">go</a>', absent: /ping|track\.test/i, present: /href="https:\/\/ok\.test\/p"/ },
  { name: 'ping_uppercase', html: '<A HREF="https://ok.test/p" PING="https://track.test/">go</A>', absent: /ping|track\.test/i, present: /https:\/\/ok\.test\/p/ },
];
