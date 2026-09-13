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
- The sanitized `html` and the `text` are each capped at 40,000 bytes. Over the
  cap is rejected, never truncated.
- From, Reply-To, CRLF cleaning, the one-recipient rule, and `/contact` are
  unchanged. `GET /selftest` reruns every sanitizer fixture on the deployed
  runtime's parser.

Errors use the platform envelope `{error, code}` with machine-readable codes
(`unauthorized`, `unknown_product`, `bad_payload`, `turnstile_failed`,
`origin_denied`, `email_upstream_failed`, `not_found`).

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
