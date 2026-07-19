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
  uses instead of rebuilding its own. Public, but gated by **server-side
  Cloudflare Turnstile** verification and a per-product **Origin allowlist**;
  the recipient is hard-fixed to the product's registered `contact_to`, so the
  worst-case abuse is Turnstile-gated self-spam. Emits the house contact
  format (TGWAB DEV-STANDARDS §6) byte for byte — From = site name, Reply-To =
  submitter, Subject `<SITE>⎯<SUBJECT>`, `white-space:pre` body — enforced by
  golden tests.
- `GET /health`.

## How it works

Per-product configuration lives in the `PRODUCTS` KV namespace, projected from
the herald registry (D1) by `notifyctl sync-mailer`: name, domain, from
address, contact recipient, allowed origins, and optionally a per-product send
token hash (`send_token_sha256`, which overrides the shared `SEND_TOKEN`).
Only public-safe fields are projected — the mailer deliberately has **no D1
binding** and holds no webhook or platform credentials, keeping the public
contact surface's blast radius minimal.

Errors use the platform envelope `{error, code}` with machine-readable codes
(`unauthorized`, `unknown_product`, `bad_payload`, `turnstile_failed`,
`origin_denied`, `email_upstream_failed`, `not_found`).

## Deploy

```bash
npm test              # node --test, zero install
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
