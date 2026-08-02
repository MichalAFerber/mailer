// mailer — the outbound email worker for the herald platform.
//
// Two jobs, one tiny worker, zero runtime dependencies:
//
//   POST /send/:product     the dead-simple programmatic email API. Auth'd
//                           callers post {to?, reply_to?, name?, subject,
//                           message} and nothing more — no SMTP hosts, no
//                           credentials, no MIME assembly.
//   POST /contact/:product  the shared contact-form endpoint every site uses
//                           instead of rebuilding its own. Public, gated by
//                           server-side Turnstile + an Origin allowlist, and
//                           it emits the house contact format (DEV-STANDARDS
//                           §6) byte for byte.
//   GET  /health
//
// Per-product config comes from the PRODUCTS KV projection (written by
// `notifyctl sync-mailer` from the herald registry): {name, domain, from_addr,
// contact_to, allowed_origins, turnstile_ref?, send_token_sha256?, icon_url?}.
// Renderers live here in tested code; only per-product data varies.
//
// `turnstile_ref` NAMES a worker secret (never a value). A Turnstile widget
// caps at 10 domains, so a single shared secret would also cap the platform at
// 10 contact-form products; a product carrying a ref rides its own widget.

import { renderShell } from './shell.js';
import { renderEmail as renderBlocks } from './template.js';
import { renderEmail as renderMarkdownEmail, MarkdownError } from './email.js';
import { iconBytes } from './icon.js';
import { FIXTURE } from './fixture.js';

// `blocks` is capped so one caller cannot post an unbounded document; the
// renderer additionally budgets the rendered size against Gmail's clip point.
const LIMITS = { name: 100, email: 254, subject: 150, message: 5000, blocks: 200, markdown: 40000 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+/g, '/').replace(/\/+$/, '') || '/';

    if (request.method === 'GET' && path === '/health') {
      return json({ status: 'up' }, 200);
    }

    // Post-deploy self-test. Exercises the whole render path in-process and
    // asserts the §9 guards still fire, then reports rather than sending.
    //
    // It exists because every render failure this worker has had looked healthy
    // from outside: /health returned 200 while `handleSend` could not run at all
    // (2026-08-02, renderMarkdownEmail and MarkdownError were used but never
    // imported — a clean-looking merge, 68 green tests, and an opaque 1101 in
    // production). A module-graph fault is exactly what a Node test suite cannot
    // see, so the check has to run in the deployed runtime.
    //
    // Deliberately unauthenticated and deliberately does NOT send: CI can call it
    // with no secret, and a smoke test that emailed on every deploy would violate
    // the rule that a job with nothing to say stays silent.
    if (request.method === 'GET' && path === '/selftest') {
      const report = { ok: false, render: null, guards: {} };
      try {
        const out = renderMarkdownEmail(FIXTURE);
        report.render = { html_bytes: out.html.length, text_bytes: out.text.length };
        // Every guard must still throw. A change that quietly disables one would
        // otherwise pass every other check and only surface as a mangled email.
        const guards = {
          wide_table: '| a | b | c | d |\n|---|---|---|---|\n| 1 | 2 | 3 | 4 |\n',
          second_h1: '# A\n\n# B\n',
          bad_pill: '## S {broken}',
          insecure_link: '[a](http://x.test)',
        };
        for (const [name, markdown] of Object.entries(guards)) {
          try {
            renderMarkdownEmail({ ...FIXTURE, markdown });
            report.guards[name] = 'DID NOT THROW';
          } catch (e) {
            // instanceof, because that is the predicate the send path uses to turn a
            // bad payload into a 400. If it ever stops holding in the deployed
            // runtime, every guard silently becomes a 500 — check what ships.
            report.guards[name] = e instanceof MarkdownError
              ? 'throws'
              : `wrong error: ${e?.constructor?.name ?? typeof e}`;
          }
        }
        report.ok = Boolean(report.render)
          && Object.values(report.guards).every((v) => v === 'throws');
      } catch (e) {
        report.error = `${e?.name}: ${e?.message}`;
      }
      return json(report, report.ok ? 200 : 500);
    }

    // Dev-only preview: renders the same fixture for eyeballing a layout change.
    // Gated on an env flag rather than a header — an unauthenticated route that
    // returns full HTML is not something to leave reachable in production.
    if (path === '/preview' && env.PREVIEW === '1') {
      const wantText = url.searchParams.get('text') === '1';
      const out = renderMarkdownEmail(FIXTURE);
      return new Response(wantText ? out.text : out.html, {
        headers: {
          'Content-Type': wantText ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8',
        },
      });
    }

    if (request.method === 'GET' && path === '/icon-192.png') {
      return new Response(iconBytes(), {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    const m = path.match(/^\/(send|contact)\/([a-z0-9_]+)$/i);
    if (!m) return json({ error: 'not found', code: 'not_found' }, 404);
    const kind = m[1].toLowerCase();
    const slug = m[2].toLowerCase();

    const product = await getProduct(env, slug);

    if (kind === 'contact' && request.method === 'OPTIONS') {
      // CORS preflight: only allowlisted origins get an answer.
      const origin = request.headers.get('Origin');
      if (!product || !originAllowed(product, origin)) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'POST') return json({ error: 'not found', code: 'not_found' }, 404);
    if (!product) return json({ error: `unknown product '${slug}'`, code: 'unknown_product' }, 404);

    return kind === 'send'
      ? handleSend(request, env, product, ctx, slug)
      : handleContact(request, env, product, ctx, slug);
  },
};


// Brand for the block renderer, derived from the same KV projection renderShell
// uses — so a product looks identical whichever lane it sends through. The logo
// is the product's own /icon-192.png (§11 manifest icon, absolute https) unless
// the projection carries an explicit icon_url.
function brandOf(product) {
  return {
    name: product.name,
    logoUrl: product.icon_url || `https://${product.domain}/icon-192.png`,
    accent: product.accent || '#a8322a',
    footerNotice: `Sent by ${product.name} from ${product.from_addr}. `
      + 'Add that address to your contacts so this keeps landing in the inbox.',
    // CAN-SPAM requires a valid physical postal address; it does not require a
    // copyright line, and a notice claiming rights over a transactional receipt
    // is noise. Legal entity + address is the whole obligation.
    footerLegal: 'ThompsonBlack LLC · PO Box 3071, Florence SC 29502',
    unsubscribeUrl: product.unsubscribe_url,
  };
}

// ---------------------------------------------------------------- /send ----

// `slug` comes from the ROUTE, not from `product`: the KV projection carries only
// public-safe display fields and has no slug, so reading it from there would send
// every failure alert to /notify/undefined.
async function handleSend(request, env, product, ctx, slug) {
  const token = request.headers.get('X-Send-Token') || bearer(request);
  if (!(await sendAuthed(env, product, token))) {
    return json({ error: 'unauthorized', code: 'unauthorized' }, 401);
  }

  let b;
  try {
    b = await request.json();
  } catch (e) {
    return json({ error: 'bad payload: ' + e.message, code: 'bad_payload' }, 400);
  }
  const subject = clean(b.subject, LIMITS.subject);
  const message = String(b.message ?? '').slice(0, LIMITS.message);
  // `blocks` is the structured lane: callers that pass it get the full template
  // (stat rows, data tables, status pills). Callers that pass `message` keep the
  // plain-text-in-a-shell behaviour unchanged — this is additive, not a swap.
  const blocks = Array.isArray(b.blocks) ? b.blocks.slice(0, LIMITS.blocks) : null;
  // The markdown lane is what §6 documents for reports: scripts author markdown,
  // the mailer parses it to an AST and emits components. It is preferred over
  // `blocks`, which stays for callers already on it.
  const markdown = typeof b.markdown === 'string' ? b.markdown.slice(0, LIMITS.markdown) : null;
  if (!subject || (!message && !blocks && !markdown)) {
    return json({ error: 'subject and one of message, markdown or blocks are required', code: 'bad_payload' }, 400);
  }
  const to = clean(b.to, LIMITS.email) || product.contact_to;
  const replyTo = clean(b.reply_to, LIMITS.email);
  if (!EMAIL_RE.test(to) || (replyTo && !EMAIL_RE.test(replyTo))) {
    return json({ error: 'invalid recipient address', code: 'bad_payload' }, 400);
  }
  const fromName = clean(b.name, LIMITS.name) || product.name;

  let rendered = null;
  if (markdown) {
    try {
      rendered = renderMarkdownEmail({
        brand: {
          name: product.name,
          logoUrl: product.icon_url || `https://${product.domain}/icon-192.png`,
          accent: product.accent || '#a8322a',
          footerNotice: `Sent by ${product.name} from ${product.from_addr}. `
            + 'Add that address to your contacts so this keeps landing in the inbox.',
          footerPostal: 'ThompsonBlack LLC · PO Box 3071, Florence SC 29502',
          unsubscribeUrl: product.unsubscribe_url,
        },
        subject,
        preheader: clean(b.preheader, LIMITS.subject) || subject,
        markdown,
        eyebrow: clean(b.eyebrow, LIMITS.name) || undefined,
        signoff: clean(b.signoff, LIMITS.subject) || undefined,
      });
    } catch (e) {
      // §9 fails loudly. Surfacing the reason to the caller is the point: the
      // author sees "table has 4 columns" rather than a mangled table landing
      // in someone's inbox.
      if (e instanceof MarkdownError) {
        return json({ error: e.message, code: 'bad_markdown' }, 400);
      }
      throw e;
    }
  }
  const renderedBlocks = !markdown && blocks
    ? renderBlocks({
        brand: brandOf(product),
        subject,
        preheader: clean(b.preheader, LIMITS.subject) || subject,
        blocks,
      })
    : null;
  rendered = rendered || renderedBlocks;

  const sent = await sendEmail(env, {
    from: `${fromName} <${product.from_addr}>`,
    to,
    replyTo,
    subject,
    html: rendered
      ? rendered.html
      : renderShell(product, {
          heading: subject,
          preheader: subject,
          body: reportHtml(message),
        }),
    // A text/plain alternative ships with every block-rendered message: a missing
    // text part hurts deliverability and makes the mail unreadable in text-only
    // clients and most watch notifications.
    text: rendered ? rendered.text : undefined,
    unsubscribe: product.unsubscribe_url,
    slug,
    lane: 'send',
    ctx,
  });
  if (!sent.ok) {
    return json({ error: 'email upstream failed', code: 'email_upstream_failed' }, 502);
  }
  return json({ sent: true, id: sent.id ?? null }, 200);
}

async function sendAuthed(env, product, token) {
  if (!token) return false;
  if (product.send_token_sha256) return (await sha256Hex(token)) === product.send_token_sha256;
  return !!env.SEND_TOKEN && token === env.SEND_TOKEN;
}

// ------------------------------------------------------------- /contact ----

async function handleContact(request, env, product, ctx, slug) {
  const origin = request.headers.get('Origin');
  if (!originAllowed(product, origin)) {
    return json({ error: 'origin not allowed', code: 'origin_denied' }, 403);
  }

  let b;
  try {
    b = await request.json();
  } catch (e) {
    return json({ error: 'bad payload: ' + e.message, code: 'bad_payload' }, 400, origin);
  }

  // Turnstile FIRST (§7): no verification, no send — and the check is
  // server-side against siteverify, never trusted from the client.
  const turnstileToken = b.turnstileToken || b['cf-turnstile-response'];
  if (!(await turnstileOk(env, turnstileToken, request, product))) {
    return json({ error: 'turnstile verification failed', code: 'turnstile_failed' }, 403, origin);
  }

  const name = clean(b.name, LIMITS.name);
  const email = clean(b.email, LIMITS.email);
  const subject = clean(b.subject, LIMITS.subject) || 'Contact form';
  const message = String(b.message ?? '').slice(0, LIMITS.message);
  if (!name || !message || !EMAIL_RE.test(email)) {
    return json({ error: 'name, valid email, and message are required', code: 'bad_payload' }, 400, origin);
  }

  // The §6 house format, byte for byte: From = site name, Reply-To =
  // submitter, Subject `<SITE>⎯<SUBJECT>`, recipient HARD-FIXED to the
  // registry contact_to (worst-case abuse is Turnstile-gated self-spam).
  const sent = await sendEmail(env, {
    from: `${product.name} <${product.from_addr}>`,
    to: product.contact_to,
    replyTo: email,
    subject: `${product.name}⎯${subject}`,
    html: renderShell(product, {
      heading: 'New contact form message',
      preheader: `${name} via ${product.domain}`,
      body: contactHtml({ name, email, message }),
    }),
    slug,
    lane: 'contact',
    ctx,
  });
  if (!sent.ok) {
    return json({ error: 'email upstream failed', code: 'email_upstream_failed' }, 502, origin);
  }
  return json({ sent: true }, 200, origin);
}

function originAllowed(product, origin) {
  if (!origin) return false;
  return Array.isArray(product.allowed_origins) && product.allowed_origins.includes(origin);
}

// Resolve the Turnstile secret for a product. A widget caps at 10 domains, so
// one shared secret also caps the platform at 10 products. `turnstile_ref`
// NAMES a worker secret (never a value) so a product can ride its own widget;
// products without one keep using the shared TURNSTILE_SECRET.
function turnstileSecret(env, product) {
  const ref = product && product.turnstile_ref;
  if (ref) {
    const scoped = env[ref];
    // A configured-but-missing secret must fail closed rather than silently
    // falling back to the shared one, which would verify against the wrong
    // widget and reject every token from the product's real sitekey.
    return scoped || null;
  }
  return env.TURNSTILE_SECRET || null;
}

async function turnstileOk(env, token, request, product) {
  const secret = turnstileSecret(env, product);
  if (!secret || !token) return false;
  try {
    const form = new FormData();
    form.set('secret', secret);
    form.set('response', token);
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip) form.set('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    const body = await res.json();
    return body.success === true;
  } catch (e) {
    console.error('turnstile verify failed:', e.message);
    return false; // fail closed: no verification, no send
  }
}

// ------------------------------------------------------------ rendering ----

// §6 contact body: Name/Email, blank line, message — preserved with
// white-space:pre (a raw tab collapses in HTML). Every user value is escaped.
export function contactHtml({ name, email, message }) {
  return `<div style="white-space:pre; font-family:system-ui, sans-serif;">Name:\t${escapeHtml(name)}
Email:\t${escapeHtml(email)}

${escapeHtml(message)}</div>`;
}

// /send bodies are script reports: pipe tables, "━━ Section" headings, and
// column-aligned monospace runs. A single white-space:pre div made them
// unreadable — the body's word-break:break-word chops long padded lines into
// run-on fragments. Render structure instead: pipe-table blocks become real
// <table>s, "━━ " lines become section headings, everything else keeps its
// whitespace in a monospace pre-wrap block. Every value is escaped per line;
// the §6 contact format (contactHtml) is untouched.
const MONO = "ui-monospace, Menlo, Consolas, 'Courier New', monospace";

export function reportHtml(message) {
  const out = [];
  let text = [];
  let table = [];
  const flushText = () => {
    if (!text.length) return;
    // Trim blank edges so spacing comes from the blocks, not stray newlines.
    const chunk = text.join('\n').replace(/^\n+|\n+$/g, '');
    if (chunk) {
      out.push(`<div style="white-space:pre-wrap; font-family:${MONO}; font-size:13px; line-height:1.5;">${escapeHtml(chunk)}</div>`);
    }
    text = [];
  };
  const flushTable = () => {
    if (!table.length) return;
    out.push(tableHtml(table));
    table = [];
  };
  for (const line of String(message).split('\n')) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushText();
      table.push(line);
    } else if (/^━+\s*\S/.test(line.trim())) {
      flushText();
      flushTable();
      const title = line.trim().replace(/^━+\s*/, '');
      out.push(`<div style="font-weight:bold; font-size:15px; color:#222222; margin:18px 0 6px;">${escapeHtml(title)}</div>`);
    } else {
      flushTable();
      text.push(line);
    }
  }
  flushText();
  flushTable();
  return out.join('\n');
}

function tableHtml(lines) {
  const rows = lines.map((l) =>
    l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
  // A markdown separator row (---, :--:) marks the row above it as the header.
  let header = null;
  if (rows.length > 1 && rows[1].every((c) => /^:?-{2,}:?$/.test(c))) {
    header = rows[0];
    rows.splice(0, 2);
  }
  const td = (c, bold) =>
    `<td style="border:1px solid #d9d9d9; padding:5px 9px; vertical-align:top;${bold ? ' font-weight:bold; background-color:#f5f5f5;' : ''}">${escapeHtml(c)}</td>`;
  const tr = (cells, bold) => `<tr>${cells.map((c) => td(c, bold)).join('')}</tr>`;
  return `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin:10px 0; font-family:${MONO}; font-size:12px; line-height:1.4;">${
    header ? tr(header, true) : ''
  }${rows.map((r) => tr(r, false)).join('')}</table>`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Strip CR/LF (header injection) and clamp. Empty -> ''.
function clean(v, max) {
  return String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

// ------------------------------------------------------------- delivery ----

// ForwardEmail REST with the 3-attempt retry proven in resizewizard-api.
async function sendEmail(env, { from, to, replyTo, subject, html, text, unsubscribe, slug, lane, ctx }) {
  const auth = 'Basic ' + btoa(env.FORWARDEMAIL_API_KEY + ':');
  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Form-encoded because that is the shape Forward Email documents (their
      // API example uses -d). A JSON body works too -- an earlier claim here
      // that JSON silently downgrades `html` to text/plain was WRONG: it came
      // from misreading Forward Email's redaction placeholder, which is always
      // `text/plain; charset=us-ascii` once a message is purged. The real type
      // is preserved in X-Original-Content-Type, and it was text/html either
      // way. Kept form-encoded to match the docs, not to fix a bug.
      const form = new URLSearchParams();
      form.set('from', from);
      form.set('to', to);
      if (replyTo) form.set('replyTo', replyTo);
      form.set('subject', subject);
      form.set('html', html);
      const res = await fetch('https://api.forwardemail.net/v1/emails', {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: true, id: body.id };
      }
      lastError = 'status ' + res.status;
      if (res.status < 500 && res.status !== 429) break; // not retryable
    } catch (e) {
      lastError = e.message;
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  console.error('sendEmail failed:', lastError);
  // A console line is not a notification. Until now an upstream rejection --
  // Forward Email refusing the message outright -- left no trace anywhere: the
  // caller got a 502, the submitter saw an error, and nobody was told. This is
  // NOT a bounce; the bounce lane only sees messages Forward Email accepted and
  // then failed to deliver. A rejected send never reaches it.
  //
  // Reported THROUGH herald rather than written to D1 directly: the mailer is
  // the public-facing surface and deliberately holds no write handle to fleet
  // history. A scoped ingest token is the whole of its privilege.
  const report = reportSendFailure(env, { slug, lane, to, subject, reason: lastError });
  if (ctx && ctx.waitUntil) ctx.waitUntil(report); else await report;
  return { ok: false };
}

// Best-effort, per-isolate throttle. /contact is public, so an upstream outage
// would otherwise turn every submission into its own Discord message. This does
// not bound the total across isolates -- it turns hundreds into a handful, which
// is the difference that matters when you are trying to read the channel.
const lastReported = new Map();
const REPORT_EVERY_MS = 5 * 60 * 1000;

// Exported for tests: module state must not leak between cases.
export function _resetReportThrottle() {
  lastReported.clear();
}

async function reportSendFailure(env, { slug, lane, to, subject, reason }) {
  if (!env.NOTIFY_URL || !env.NOTIFY_TOKEN) return;
  const now = Date.now();
  const key = `${slug}:${lane}`;
  if (now - (lastReported.get(key) ?? 0) < REPORT_EVERY_MS) return;
  lastReported.set(key, now);

  try {
    const res = await fetch(`${env.NOTIFY_URL}/notify/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': env.NOTIFY_TOKEN },
      body: JSON.stringify({
        level: 'error',
        source: 'mailer',
        title: `Outbound email REJECTED — ${slug} (${lane})`,
        description:
          'Forward Email refused the message after 3 attempts, so it was never queued and ' +
          'will NOT produce a bounce. The recipient did not get it.',
        fields: [
          { name: 'Recipient', value: String(to || 'unknown') },
          { name: 'Subject', value: String(subject || '(none)') },
          { name: 'Upstream', value: String(reason || 'unknown') },
        ],
      }),
    });
    if (!res.ok) console.error('sendEmail failure report rejected:', res.status);
  } catch (e) {
    // The platform being down must never turn a send failure into an exception
    // on the request path.
    console.error('sendEmail failure report failed:', e.message);
  }
}

// ----------------------------------------------------------------- misc ----

async function getProduct(env, slug) {
  if (!env.PRODUCTS) return null;
  try {
    return await env.PRODUCTS.get('product:' + slug, 'json');
  } catch (e) {
    console.error('product lookup failed:', e.message);
    return null;
  }
}

function bearer(request) {
  const h = request.headers.get('Authorization');
  return h && h.startsWith('Bearer ') ? h.slice(7) : null;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? corsHeaders(origin) : {}),
    },
  });
}
