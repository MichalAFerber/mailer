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
// contact_to, allowed_origins, turnstile_ref?, send_token_sha256?}. Renderers
// live here in tested code; only per-product data varies.
//
// `turnstile_ref` NAMES a worker secret (never a value). A Turnstile widget
// caps at 10 domains, so a single shared secret would also cap the platform at
// 10 contact-form products; a product carrying a ref rides its own widget.

const LIMITS = { name: 100, email: 254, subject: 150, message: 5000 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+/g, '/').replace(/\/+$/, '') || '/';

    if (request.method === 'GET' && path === '/health') {
      return json({ status: 'up' }, 200);
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
  if (!subject || !message) {
    return json({ error: 'subject and message are required', code: 'bad_payload' }, 400);
  }
  const to = clean(b.to, LIMITS.email) || product.contact_to;
  const replyTo = clean(b.reply_to, LIMITS.email);
  if (!EMAIL_RE.test(to) || (replyTo && !EMAIL_RE.test(replyTo))) {
    return json({ error: 'invalid recipient address', code: 'bad_payload' }, 400);
  }
  const fromName = clean(b.name, LIMITS.name) || product.name;

  const sent = await sendEmail(env, {
    from: `${fromName} <${product.from_addr}>`,
    to,
    replyTo,
    subject,
    html: preformattedHtml(message),
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
    html: contactHtml({ name, email, message }),
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

function preformattedHtml(message) {
  return `<div style="white-space:pre; font-family:system-ui, sans-serif;">${escapeHtml(message)}</div>`;
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
async function sendEmail(env, { from, to, replyTo, subject, html, slug, lane, ctx }) {
  const auth = 'Basic ' + btoa(env.FORWARDEMAIL_API_KEY + ':');
  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch('https://api.forwardemail.net/v1/emails', {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to,
          ...(replyTo ? { replyTo } : {}),
          subject,
          html,
        }),
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
