# mailer

Class A — public, MIT. Outbound email worker for the herald notification
platform. Live at `https://mailer.thompsonblack.us`.

One tiny Cloudflare Worker, zero runtime dependencies, two jobs:

- **`POST /send/:product`** — the dead-simple programmatic email API.
  Authenticated callers (`X-Send-Token` or `Authorization: Bearer`) post
  `{to?, reply_to?, name?, subject, message}` and nothing more — no SMTP
  hosts, no credentials, no MIME assembly. Delivery via the ForwardEmail REST
  API with a 3-attempt retry.
- **`POST /contact/:product`** — the shared contact-form endpoint every site
  uses instead of rebuilding its own. Public, but gated by a per-product
  **Origin allowlist first**, then **server-side Cloudflare Turnstile**;
  the recipient is hard-fixed to the product's registered `contact_to`, so the
  worst-case abuse is Turnstile-gated self-spam. Emits the house contact
  format (TGWAB DEV-STANDARDS §6) byte for byte — From = site name, Reply-To =
  submitter, Subject `<SITE>⎯<SUBJECT>`, `white-space:pre` body — enforced by
  golden tests. A product's own `/api/contact` (for example
  `https://ipcow.com/api/contact`) is a **different surface**: it may check
  Turnstile locally and call `POST /send/:product` with a send token. Probing
  that URL cannot settle whether this Worker's allowlist runs.
- `GET /health`.

## How it works

Per-product configuration lives in the `PRODUCTS` KV namespace, projected from
the herald registry (D1) by `notifyctl sync-mailer`: name, domain, from
address, contact recipient, allowed origins, and optionally a per-product send
token hash (`send_token_sha256`, which overrides the shared `SEND_TOKEN`).

Because that projection is a whole-value `kv key put`, **KV is never the place to
write a product field** — anything D1 cannot supply is dropped on the next sync.
A per-product send token is therefore minted into the registry, not into KV:

```bash
notifyctl token mint send-<slug> --product <slug> --kind send   # D1: the source of truth
notifyctl sync-mailer                                           # D1 -> KV projection
# then set the printed token as MAILER_SEND_TOKEN on the consumer and restart it
```

`sync-mailer` picks the hash up from the token row named `send-<slug>`. Mint
before syncing, and sync before updating the consumer: a consumer updated first
holds a token the mailer cannot verify yet.
Only public-safe fields are projected — the mailer deliberately has **no D1
binding** and holds no webhook or platform credentials, keeping the public
contact surface's blast radius minimal.

## Brand override (white-label products)

A product registered with **both** `white_label` and `transactional_only` may
send its own fully assembled document instead of the house layout:

```json
{ "subject": "Sign in to Acme",
  "to": "user@example.com",
  "brand_override": { "html": "<!DOCTYPE html>…", "text": "…", "suppress_platform_wrapper": true } }
```

- Both flags are registry fields, set in D1 and projected by `sync-mailer`. The
  request body cannot grant them. Setting them is a credential-tier operation.
- `suppress_platform_wrapper` must be `true`; `html` is required and `text` is
  optional. Any other field, a product without both flags, or a body that also
  carries `message`, `markdown`, or `blocks` is `400 bad_payload`.
- `html` is sanitized on HTMLRewriter (`src/sanitize.js`): `script`, `iframe`,
  `object`, `embed`, `form`, `base`, `link`, and `meta` refresh are dropped;
  every `on*` attribute is stripped; `href`, `src`, each `srcset` candidate,
  `action`, `formaction`, `background`, `poster`, `data`, and `xlink:href` keep
  only absolute `https://` values.
- The sanitized `html` and the `text` are each capped at 90,000 bytes. Over the
  cap is rejected, never truncated.
- From, Reply-To, CRLF cleaning, the one-recipient rule, and `/contact` are
  unchanged. `GET /selftest` reruns every sanitizer fixture on the deployed
  runtime's parser.

Errors use the platform envelope `{error, code}` with machine-readable codes
(`unauthorized`, `unknown_product`, `bad_payload`, `turnstile_failed`,
`origin_denied`, `email_upstream_failed`, `not_found`).

## Admin directory (service binding, read-only)

`admin.tgwab.us` mirrors the Forward Email account: its domains, their aliases,
which product sends from which domain, and the mail this Worker has sent (the
panel's Message log). The account-wide Forward Email key
lives in this Worker and nowhere else (DEV-STANDARDS §6), so the admin Worker
reads through a named entrypoint, `AdminDirectory`, over a service binding:

```toml
# In the consumer's wrangler.toml (tgwab-admin).
[[services]]
binding = "MAILER_DIRECTORY"
service = "mailer"
entrypoint = "AdminDirectory"
```

```js
const domains = await env.MAILER_DIRECTORY.feDomains();
const aliases = await env.MAILER_DIRECTORY.feAliases('example.com');
const products = await env.MAILER_DIRECTORY.products();
const sent = await env.MAILER_DIRECTORY.feEmails(1);
```

The binding is the authentication. No route, header, query parameter, or
hostname reaches these methods: `mailer.thompsonblack.us` delivers to the
default export (`src/index.js`), which never imports `src/directory.js`. The
entrypoint has these four methods and no `fetch`. Each is a read: one `GET` to
Forward Email, a `list` and `get` on the `PRODUCTS` KV, or, for `feEmails`, both.
Nothing is written, sent, retried, or cached, so every call asks again.

Every answer is an allow-list. A field not in the tables below does not cross,
and a value of the wrong shape (a flag that is not a boolean, an id that is not
24 hex characters, an address that is not an address) crosses as `null`.

### `feDomains()`

One `GET /v1/domains?pagination=false`. Returns one object per domain:

| Field | Value |
|---|---|
| `id` | Forward Email's id for the domain, 24 hex characters |
| `name` | the domain, as a lowercase hostname |
| `plan` | `free`, `enhanced_protection`, or `team` |
| `has_mx_record`, `has_txt_record` | inbound: the MX and the verification TXT are in place |
| `has_smtp`, `smtp_verified_at`, `is_smtp_suspended` | outbound: whether, and since when, this Worker may send from the domain |
| `has_dkim_record`, `has_return_path_record`, `has_dmarc_record` | outbound DNS, as Forward Email last checked it |
| `bounce_webhook` | `null` when unset; otherwise `{ kind: "webhook", host, path }` or `{ kind: "other" }` (see below) |

Not returned, among everything else: `verification_record`, `smtp_dns_records`,
the S3 settings, `allowlist`, `denylist`, `custom_verification`, members,
invites, and the storage and retention settings.

### `feAliases(domain)`

`domain` is a lowercase hostname (`example.com`), checked before it goes into a
URL; anything else throws `invalid_domain` and Forward Email is not called. One
`GET /v1/domains/<domain>/aliases?pagination=false`. Returns one object per
alias:

| Field | Value |
|---|---|
| `id` | Forward Email's id for the alias, 24 hex characters |
| `name` | the local part; `*` is the catch-all |
| `is_enabled` | whether the alias accepts mail |
| `has_imap` | whether mail is stored in a mailbox; `null` when Forward Email leaves the field out, which is not the same as off |
| `recipients` | a list of `{ kind: "email", address }`, `{ kind: "webhook", host, path }`, or `{ kind: "other" }`; `null` when Forward Email returns no list |

Not returned, among everything else: `description`, `labels`,
`vacation_responder`, `verified_recipients`, `pending_recipients`, the PGP key,
and the account and domain objects Forward Email nests in every alias.

### `products()`

The `PRODUCTS` KV as this Worker holds it, one object per `product:<slug>` key:

| Field | Value |
|---|---|
| `slug` | from the key; the record has none |
| `name` | the display name mail is sent under |
| `domain` | the product's domain |
| `from_addr` | the sender address |
| `contact_to` | where `/contact/<slug>` delivers |
| `allowed_origins` | the origins that may post to `/contact/<slug>`, each cut to scheme and host |
| `white_label`, `transactional_only` | both `true` is what admits the brand-override lane |
| `has_send_token` | `true` when `/send/<slug>` takes the product's own token, `false` when it takes the shared one |

Not returned: `send_token_sha256`, `turnstile_ref`, `icon_url`, `accent`,
`unsubscribe_url`, and any field the record gains later.

### `feEmails(page)`

`page` is a whole number from 1 to 100; anything else throws `invalid_page` and
Forward Email is not called. The `PRODUCTS` KV is read first, as `products()`
reads it, and then one `GET /v1/emails?limit=100&page=<page>&sort=-created_at`:
one page of the account's outbound mail, newest first. Returns one object:

| Field | Value |
|---|---|
| `emails` | the messages on the page that this Worker sent, as below |
| `page` | the page asked for |
| `has_more` | whether Forward Email holds a later page: by its `X-Page-Count` header, or, without one, by whether this page held 100 |
| `oldest_created_at` | the earliest `created_at` on the page, before the filter below, so a caller reading back to a date knows when to stop; `null` on an empty page |
| `others` | how many messages on the page were not sent as a product's `from_addr`; only the count crosses |

A message is in `emails` only when its envelope sender is the `from_addr` of a
product record. The account also holds client domains whose people send their
own mail through Forward Email, and none of that crosses. Each message:

| Field | Value |
|---|---|
| `id` | Forward Email's id for the message, 24 hex characters |
| `created_at` | when Forward Email accepted it, as ISO 8601 UTC |
| `status` | `pending`, `queued`, `sent`, `partially_sent`, `deferred`, `bounced`, or `rejected` |
| `from` | the envelope sender, lowercased: a product's `from_addr` |
| `to` | the envelope recipients (To, Cc, and Bcc together), addresses only, at most 50 |
| `subject` | the subject as one line, cut to 300 characters |
| `message_id` | the `Message-ID` header, angle brackets included |
| `products` | the slugs of every product that sends as `from`, sorted; several products can share one address |

Not returned, among everything else: the message itself, its headers, the
delivery and rejection details (they quote the recipient servers' answers), the
account, alias, and domain ids, and the `link` to Forward Email's dashboard.

### Webhook URLs

A domain's `bounce_webhook` and an alias's recipients can be URLs with a secret
in the path, as herald's `/bounce/<secret>` and `/email-in/<secret>` are. A URL
never crosses. An `http` or `https` URL becomes
`{ kind: "webhook", host, path }`, where `path` is `/<first-segment>/[redacted]`:

- The query, the fragment, and any userinfo are dropped.
- The first segment is kept only when another segment follows it and it reads
  as a route name: lowercase letters and hyphens, 16 at most. A path of one
  segment, or one whose first segment has a digit or a capital in it, is
  `/[redacted]`. No path is `/`.
- The host is returned whole, so a secret carried in a hostname would cross.

A recipient that is an email address is `{ kind: "email", address }`. Anything
else (a bare hostname, an IP, a URL of another scheme, a value that is not a
string) is `{ kind: "other" }`, with no value.

### Errors

A failure is a thrown `Error` named `DirectoryError`. Its `code` is one of the
values below, and its `message` is `<code>: <detail>`, so the code is readable
from either. An account with no domains, a domain with no aliases, and a KV
with no products are each an empty list, never an error.

| Code | Meaning |
|---|---|
| `invalid_domain` | `feAliases` was not given a lowercase hostname; Forward Email was not called |
| `invalid_page` | `feEmails` was not given a page from 1 to 100; Forward Email was not called |
| `fe_unreachable` | the request to Forward Email did not complete |
| `fe_status` | Forward Email answered outside 2xx; the message carries the status |
| `fe_bad_body` | a 2xx whose body is not a JSON list |
| `fe_incomplete` | `feDomains` or `feAliases`: Forward Email holds more rows than the one page (1,000) it returned |

No message quotes a response body. A KV failure in `products()` or `feEmails()`
is thrown as it came.

## Deploy

```bash
npm ci && npm test    # node --test; the sanitizer tests need html-rewriter-wasm
npx wrangler deploy   # TGWAB account, mailer.thompsonblack.us
```

Secrets (values live in Proton Pass, materialized via the herald repo's
`bin/sync-secrets` pattern): `FORWARDEMAIL_API_KEY`, `TURNSTILE_SECRET`,
`SEND_TOKEN`.

## Privacy

No storage. Form submissions are validated, HTML-escaped, checked against
Turnstile, sent as email, and forgotten — nothing is logged beyond Cloudflare's
standard worker logs.

## Credits

| Component | Use | License |
|---|---|---|
| Cloudflare Workers / Turnstile | runtime + anti-abuse | — |
| ForwardEmail REST API | email delivery | — |

MIT © 2026 Michal Ferber
