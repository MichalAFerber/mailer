// The read-only directory behind the AdminDirectory entrypoint (src/worker.js).
//
// admin.tgwab.us mirrors the Forward Email account: its domains, their aliases,
// and which product sends from which domain. DEV-STANDARDS §6 keeps the
// account-wide Forward Email key in this Worker and nowhere else, so the admin
// Worker (tgwab-admin) does not get the key. It calls the three reads below over
// a service binding, on a schedule, and stores the answers in its own database.
//
// THE BINDING IS THE AUTHENTICATION, so nothing below asks for a token. That is
// sound for one reason only: no hostname reaches this module. The route delivers
// to the default export (src/index.js), which never imports this file, and a
// named entrypoint is reached only by a Worker in this account that declares a
// binding to it. So do not import this module from the HTTP path, and do not add
// a header, a query parameter, or a hostname that selects it: anything a request
// can carry, a public caller can send. test/directory.test.js fails if any
// module but src/worker.js imports this one.
//
// READ-ONLY: one GET to Forward Email per call, or `list` and `get` on the
// PRODUCTS KV. Nothing here writes KV, sends mail, retries, caches, or reports
// to herald. A failure is thrown to the caller, who asked and will ask again.
//
// NOTHING SECRET CROSSES, by allow-list and never by deny-list. Each answer is
// built one named field at a time, and each value is checked for its shape on
// the way out: a flag that is not a boolean, an id that is not an id, or an
// address that is not an address crosses as null. A field Forward Email or the
// KV record gains tomorrow does not cross until someone reads it and names it
// here. README.md carries the same lists, and the suite holds the two together.

const FE_API = 'https://api.forwardemail.net/v1';

// The caller tells a failure from "no domains" by the throw itself: an empty
// account is an empty array. Through a service binding the caller receives a
// plain Error with this name, message, and code (measured in a local workerd
// on 2026-10-11, at this Worker's compatibility date). The code leads the
// message as well, so a caller that reads only the message still has it.
//
//   invalid_domain   feAliases was not given a hostname; Forward Email was not called
//   fe_unreachable   the request to Forward Email did not complete
//   fe_status        Forward Email answered outside 2xx; the message has the status
//   fe_bad_body      a 2xx whose body is not a JSON list
//   fe_incomplete    Forward Email holds more rows than the one page it returned
//
// No message quotes a response body or a parser's complaint about one: either
// can repeat a recipient, and a recipient can be a webhook URL with its secret.
export class DirectoryError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'DirectoryError';
    this.code = code;
  }
}

// ------------------------------------------------------------- shapes ----

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_PART = /^[A-Za-z0-9._%+'-]+$/;

// Lowercase ASCII, two labels or more, a last label that is not a number, and
// no trailing dot. Forward Email stores a domain's name in lowercase, and
// feAliases puts this value into a URL path, so nothing that could add a
// segment, a query, or a second meaning gets through.
export function isHostname(v) {
  if (typeof v !== 'string' || v.length > 253) return false;
  const labels = v.split('.');
  return labels.length > 1 && labels.every((label) => LABEL.test(label)) && /[a-z]/.test(labels.at(-1));
}

// Stricter than the EMAIL_RE the send path uses, on purpose. That one accepts
// `https://user:pass@host.example/path`, and here such a value would be handed
// back whole.
function isEmail(v) {
  if (typeof v !== 'string' || v.length > 254) return false;
  const at = v.lastIndexOf('@');
  return at > 0 && LOCAL_PART.test(v.slice(0, at)) && isHostname(v.slice(at + 1).toLowerCase());
}

const flag = (v) => (typeof v === 'boolean' ? v : null);
const text = (v) => (typeof v === 'string' ? v : null);
const matching = (re) => (v) => (typeof v === 'string' && re.test(v) ? v : null);
const objectId = matching(/^[a-f0-9]{24}$/);
const isoDate = matching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
const planName = matching(/^[a-z_]{1,32}$/);
// The slug the router accepts in /send/<slug> and /contact/<slug>.
const routeSlug = matching(/^[a-z0-9_]+$/);
const hostname = (v) => (isHostname(v) ? v : null);
const email = (v) => (isEmail(v) ? v : null);

// A webhook URL is a credential when its path carries a secret, as herald's
// /bounce/<secret> and /email-in/<secret> do. So a URL never crosses. What
// crosses is its host and, at most, its first path segment:
//
//   - the query, the fragment, and any userinfo are dropped;
//   - the first segment is kept only when another segment follows it and it
//     reads as a route name: lowercase letters and hyphens, 16 at most. A path
//     of one segment may be all secret (https://hook.example.com/<token>), and
//     so may a first segment with a digit or a capital in it;
//   - everything after it is the literal [redacted].
//
// A value wrongly masked costs a glance; one wrongly returned costs a rotation.
// The host is returned as it is, so a secret carried in a hostname would cross.
const ROUTE_NAME = /^[a-z][a-z-]{0,15}$/;
const REDACTED = '[redacted]';

export function webhookShape(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { kind: 'other' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { kind: 'other' };
  const segments = url.pathname.split('/').filter(Boolean);
  let path = '/';
  if (segments.length > 1 && ROUTE_NAME.test(segments[0])) path = `/${segments[0]}/${REDACTED}`;
  else if (segments.length) path = `/${REDACTED}`;
  return { kind: 'webhook', host: url.host, path };
}

// Forward Email accepts an address, a webhook URL, a hostname, or an IP as a
// recipient. The URL test runs first and is wide: anything with `://` in it is
// treated as a URL and never as an address.
export function recipientShape(value) {
  if (typeof value !== 'string') return { kind: 'other' };
  if (/:\/\/|^https?:/i.test(value)) return webhookShape(value);
  if (isEmail(value)) return { kind: 'email', address: value };
  return { kind: 'other' };
}

// ------------------------------------------------------ Forward Email ----

// The same key, base URL, and Basic auth as sendEmail in index.js, and none of
// its retry: this is a read on the caller's schedule, and the caller is told.
//
// Forward Email pages both lists at 1,000 rows and ignores `pagination=false`
// (its routes/api/v1/index.js, read at d706205 on 2026-10-11). It states the
// full count in X-Item-Count, so a list that was cut short is refused here
// rather than mirrored as though it were whole.
async function feList(env, path) {
  let res;
  try {
    res = await fetch(FE_API + path, {
      headers: { Authorization: 'Basic ' + btoa(env.FORWARDEMAIL_API_KEY + ':') },
    });
  } catch (e) {
    throw new DirectoryError('fe_unreachable', `no answer from Forward Email (${e?.name ?? 'Error'})`);
  }
  if (!res.ok) throw new DirectoryError('fe_status', `Forward Email answered ${res.status}`);
  const rows = await res.json().catch(() => null);
  if (!Array.isArray(rows)) {
    throw new DirectoryError('fe_bad_body', 'Forward Email answered 2xx without a JSON list');
  }
  if (Number(res.headers.get('X-Item-Count')) > rows.length) {
    throw new DirectoryError('fe_incomplete', `Forward Email returned ${rows.length} rows of a longer list`);
  }
  return rows;
}

// One call to Forward Email, for every domain on the account.
export async function feDomains(env) {
  const rows = await feList(env, '/domains?pagination=false');
  return rows.map((d) => ({
    id: objectId(d?.id),
    name: hostname(d?.name),
    plan: planName(d?.plan),
    // Inbound: the MX and the verification TXT are in place.
    has_mx_record: flag(d?.has_mx_record),
    has_txt_record: flag(d?.has_txt_record),
    // Outbound: whether Forward Email lets this Worker send from the domain.
    has_smtp: flag(d?.has_smtp),
    smtp_verified_at: isoDate(d?.smtp_verified_at),
    is_smtp_suspended: flag(d?.is_smtp_suspended),
    has_dkim_record: flag(d?.has_dkim_record),
    has_return_path_record: flag(d?.has_return_path_record),
    has_dmarc_record: flag(d?.has_dmarc_record),
    // Where bounces are posted. null when the domain has none.
    bounce_webhook: d?.bounce_webhook == null || d.bounce_webhook === ''
      ? null
      : webhookShape(d.bounce_webhook),
  }));
}

// One call to Forward Email, for one domain's aliases.
export async function feAliases(env, domain) {
  if (!isHostname(domain)) {
    throw new DirectoryError('invalid_domain', 'feAliases takes a lowercase hostname, such as example.com');
  }
  const rows = await feList(env, `/domains/${domain}/aliases?pagination=false`);
  return rows.map((a) => ({
    id: objectId(a?.id),
    // The local part: `*` is the catch-all, and a name in slashes is a regex.
    name: text(a?.name),
    is_enabled: flag(a?.is_enabled),
    // null when Forward Email leaves the field out, which is not the same as off.
    has_imap: flag(a?.has_imap),
    recipients: Array.isArray(a?.recipients) ? a.recipients.map(recipientShape) : null,
  }));
}

// ------------------------------------------------------------ products ----

const PRODUCT = 'product:';
// What one KV read of several keys accepts. Read that way so the whole answer
// costs one operation per hundred products, not one per product: Workers Free
// allows 50 subrequests in an invocation, and every KV read is one.
const KV_READ_MAX = 100;

// An allowed origin is a scheme and a host. Read through URL so that an entry
// written with a path, a query, or userinfo loses them on the way out.
function origin(v) {
  try {
    const url = new URL(v);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

// The product records as this Worker holds them: the PRODUCTS KV, as projected
// by herald's `notifyctl sync-mailer`. The slug is the key's, because the record
// has none. A KV failure is not caught: "could not read" must not arrive as
// "no products".
export async function products(env) {
  const keys = [];
  let cursor;
  do {
    const page = await env.PRODUCTS.list({ prefix: PRODUCT, cursor });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const out = [];
  for (let i = 0; i < keys.length; i += KV_READ_MAX) {
    const records = await env.PRODUCTS.get(keys.slice(i, i + KV_READ_MAX), 'json');
    for (const [key, p] of records) {
      // Listed, and gone by the time it was read.
      if (p === null) continue;
      out.push({
        slug: routeSlug(key.slice(PRODUCT.length)),
        name: text(p?.name),
        domain: hostname(p?.domain),
        from_addr: email(p?.from_addr),
        contact_to: email(p?.contact_to),
        // Who may post to /contact/<slug>.
        allowed_origins: Array.isArray(p?.allowed_origins) ? p.allowed_origins.map(origin) : null,
        // Both must be a literal true for the brand-override lane (sanitize.js).
        white_label: p?.white_label === true,
        transactional_only: p?.transactional_only === true,
        // Whether /send/<slug> takes the product's own token or the shared one,
        // decided as sendAuthed decides it. The hash itself stays here.
        has_send_token: Boolean(p?.send_token_sha256),
      });
    }
  }
  return out;
}
