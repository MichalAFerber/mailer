#!/usr/bin/env bash
# mailer-token-provision.sh — RETIRED. Do not use.
#
# This script minted a /send token and wrote `send_token_sha256` straight to the
# product's KV record. KV is not the source of truth for that field: it is a
# projection. `notifyctl sync-mailer` rebuilds each product:<slug> record from
# D1 and writes it back with a whole-value `kv key put`, so any field that D1
# cannot supply is dropped on the next sync.
#
# The hash D1 supplies comes from a token row named 'send-<slug>':
#
#     LEFT JOIN tokens t ON t.name = 'send-' || p.slug
#       AND t.scope_kind = 'send' AND t.revoked_at IS NULL
#
# This script never created that row. So every token it minted worked until the
# next unrelated sync-mailer run, then stopped — the product record lost its
# hash, sendAuthed() fell through to the shared SEND_TOKEN, and the caller
# started getting 401 unauthorized with nothing logged anywhere. That is what
# took ipcow.com's contact form down: no one rotated anything.
#
# notifyctl already mints correctly, and does more than this ever did: it proves
# the product exists first, and on rotation it demotes the live hash to
# prev_token_sha256 for 24h so the old token keeps working while you roll the
# new one out.
set -euo pipefail

SLUG="${1:-<slug>}"
[ "$SLUG" = "--apply" ] && SLUG="<slug>"

cat >&2 <<MSG

mailer-token-provision.sh is retired — it wrote to KV, which sync-mailer overwrites.

Use the registry instead:

    notifyctl token mint send-$SLUG --product $SLUG --kind send
    notifyctl sync-mailer

Then set the printed token as MAILER_SEND_TOKEN on the consumer and restart it.
Order matters: mint (D1) first, then sync (KV), then the consumer. Setting the
consumer before syncing leaves it holding a token the mailer cannot verify yet.

Store the token in Proton Pass as 'herald/token/send-$SLUG'. It is shown once.

MSG
exit 2
