#!/usr/bin/env bash
# mailer-token-provision.sh — mint a /send token for a product and register its hash.
#
# The mailer never stores a send token, only `send_token_sha256` on the product's KV
# record. So provisioning is: generate → hash → write the hash → hand the token to the
# operator exactly once. Nothing here writes the token to disk or to git.
#
# Rotation is the same operation: run it again. The previous token stops working the
# moment the new hash lands, so update the consumer promptly.
#
#   scripts/mailer-token-provision.sh <slug> [--apply]
#
# Without --apply it prints what it would change and mints nothing.
set -euo pipefail

SLUG="${1:-}"
APPLY=0
for a in "$@"; do [ "$a" = "--apply" ] && APPLY=1; done
[ -n "$SLUG" ] && [ "$SLUG" != "--apply" ] || { echo "usage: $0 <slug> [--apply]" >&2; exit 2; }

# KV namespace comes from wrangler.toml so this cannot drift from the deployed binding.
HERE="$(cd "$(dirname "$0")/.." && pwd)"
NS=$(grep -A5 'kv_namespaces' "$HERE/wrangler.toml" | grep -E '^\s*id\s*=' | head -1 | sed 's/.*"\(.*\)".*/\1/')
[ -n "$NS" ] || { echo "could not read the KV namespace id from wrangler.toml" >&2; exit 1; }

cur=$(npx --yes wrangler kv key get "product:$SLUG" --namespace-id "$NS" --remote 2>/dev/null || true)
[ -n "$cur" ] || { echo "no such product: product:$SLUG" >&2; exit 1; }

has=$(printf '%s' "$cur" | python3 -c "import json,sys; print('yes' if json.load(sys.stdin).get('send_token_sha256') else 'no')")
echo "product : $SLUG"
echo "namespace: $NS"
echo "send_token_sha256 currently set: $has"

if [ "$APPLY" != 1 ]; then
  echo
  echo "(dry run — rerun with --apply to mint and register a token)"
  exit 0
fi

# 32 bytes, URL-safe. Held in a shell variable only; never written to a file.
TOKEN=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
HASH=$(printf '%s' "$TOKEN" | shasum -a 256 | cut -d' ' -f1)

printf '%s' "$cur" | python3 -c "
import json,sys
d=json.load(sys.stdin); d['send_token_sha256']='$HASH'
print(json.dumps(d))
" | npx --yes wrangler kv key put "product:$SLUG" --namespace-id "$NS" --remote --path /dev/stdin >/dev/null

echo "registered new send_token_sha256 (${HASH:0:12}…)"
echo
echo "─────────────────────────────────────────────────────────────────────"
echo " Token — shown ONCE. Store it in Proton Pass, then set it on the box."
echo
echo "   $TOKEN"
echo
echo " Proton Pass : DevOps/mailer send-token [$SLUG]"
echo " Consumer    : MAILER_SEND_TOKEN in the product's environment"
echo "─────────────────────────────────────────────────────────────────────"
echo
echo "verify:  curl -sS -X POST https://mailer.thompsonblack.us/send/$SLUG \\"
echo "           -H 'Content-Type: application/json' -H \"X-Send-Token: \$TOKEN\" \\"
echo "           --data '{\"subject\":\"provision test\",\"message\":\"hello\"}'"
