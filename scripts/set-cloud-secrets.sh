#!/usr/bin/env bash
# Push the portal/notification secrets from the local .env to GitHub Actions
# secrets for .github/workflows/scheduled.yml.
#
# Values are piped straight from .env into `gh secret set` over stdin — they
# are never printed, never land in shell history, and never leave the machine
# except into GitHub's secret store. R2 credentials are NOT in .env (they come
# from the Cloudflare dashboard); the commands for those are printed at the end.
#
# Usage: scripts/set-cloud-secrets.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "error: no .env found in repo root" >&2
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI is required (https://cli.github.com)" >&2
  exit 1
fi

# Keys the scheduled workflow needs, sourced from .env when non-empty.
ENV_KEYS=(SCHOOL_URL SCHOOL_USERNAME SCHOOL_PASSWORD TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID HEALTHCHECK_URL)

shopt -s extglob
set_secret() { # name, value read from global vars to keep this readable
  printf '%s' "$_value" | gh secret set "$_key"
  echo "set $_key"
}

while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ "$line" =~ ^[[:space:]]*($|#) ]] && continue
  [[ "$line" != *=* ]] && continue
  _key="${line%%=*}"
  _value="${line#*=}"
  _key="${_key//[[:space:]]/}"
  _value="${_value%%+([[:space:]])}" # trim trailing whitespace
  _value="${_value##+([[:space:]])}" # trim leading whitespace
  _value="${_value%\"}"              # strip surrounding quotes (dotenv-style)
  _value="${_value#\"}"
  _value="${_value%\'}"
  _value="${_value#\'}"
  for wanted in "${ENV_KEYS[@]}"; do
    if [[ "$_key" == "$wanted" ]]; then
      if [[ -z "$_value" ]]; then
        echo "skip $_key (empty in .env)"
      else
        set_secret
      fi
    fi
  done
done < .env

echo
echo "Remaining secrets are NOT in .env — set them manually from the Cloudflare R2 dashboard:"
echo "  gh secret set R2_BUCKET --body 'myschoolone-photos'"
echo "  gh secret set R2_ENDPOINT --body 'https://<account-id>.r2.cloudflarestorage.com'"
echo "  gh secret set R2_ACCESS_KEY_ID --body '<access key id>'"
echo "  gh secret set R2_SECRET_ACCESS_KEY --body '<secret access key>'"
echo
echo "Verify with: gh secret list"
