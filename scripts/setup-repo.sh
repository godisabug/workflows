#!/usr/bin/env bash
# Sets up Codex PR review in repositories of $OWNER (default godisabug):
#   1. turns on GitHub's immutable OIDC subject (matched by the Tailscale credential);
#   2. sets the secrets from a local file, skipping ones the repository already has;
#   3. commits templates/codex-pr-review.yml to the default branch if it is missing there.
# Every step is skipped when already done, so it is safe to rerun.
set -euo pipefail

usage() {
  cat <<EOF
Usage: $0 [options] <repo>...
       $0 [options] --all

  --all              every non-archived, non-fork repository of $owner except workflows
  --rotate-secrets   overwrite secrets the repository already has
  -n, --dry-run      print what would change, change nothing
  -h, --help         show this help

Secrets are read from \$CODEX_REVIEW_SECRETS
(default ~/.config/codex-pr-review/secrets.env), one NAME=value per line:
  ${names[*]}
Only OPENAI_API_KEY is required; the others are for the gateway over Tailscale.
EOF
}

owner=${OWNER:-godisabug}
secrets_file=${CODEX_REVIEW_SECRETS:-$HOME/.config/codex-pr-review/secrets.env}
template=$(cd "$(dirname "$0")/.." && pwd)/templates/codex-pr-review.yml
workflow_path=.github/workflows/codex-pr-review.yml
names=(OPENAI_API_KEY RESPONSES_API_ENDPOINT TS_OAUTH_CLIENT_ID TS_AUDIENCE)

dry_run=false
all=false
rotate=false
repos=()
while (($#)); do
  case $1 in
    --all) all=true ;;
    --rotate-secrets) rotate=true ;;
    -n | --dry-run) dry_run=true ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) repos+=("${1#"$owner"/}") ;;
  esac
  shift
done
if { $all && ((${#repos[@]})); } || { ! $all && ((${#repos[@]} == 0)); }; then
  usage >&2
  exit 2
fi

# Parse the secrets file without executing it. Values are kept in secret_<NAME>.
load_secrets() {
  if [[ ! -f $secrets_file ]]; then
    $dry_run && { echo "note: $secrets_file not found; secrets will be listed as missing" >&2; return; }
    echo "error: $secrets_file not found (see --help)" >&2
    exit 1
  fi
  local mode
  mode=$(stat -c %a "$secrets_file" 2>/dev/null || stat -f %Lp "$secrets_file")
  if ((8#$mode & 077)); then
    echo "warning: $secrets_file is readable by others; run: chmod 600 $secrets_file" >&2
  fi
  local line key
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
    key=${line%%=*}
    if [[ $line != *=* || " ${names[*]} " != *" $key "* ]]; then
      echo "error: $secrets_file: unexpected line for '${key}'; expected NAME=value with NAME one of: ${names[*]}" >&2
      exit 1
    fi
    printf -v "secret_$key" '%s' "${line#*=}"
  done <"$secrets_file"
  if [[ -z ${secret_OPENAI_API_KEY:-} ]]; then
    echo "error: $secrets_file has no OPENAI_API_KEY" >&2
    exit 1
  fi
}

# errexit is off inside functions called from `if`/`||`, so failures return explicitly.
setup_repo() {
  local full=$owner/$1 immutable existing name value var branch

  immutable=$(gh api "repos/$full/actions/oidc/customization/sub" --jq .use_immutable_subject) || return
  if [[ $immutable == true ]]; then
    echo "  oidc: immutable subject already on"
  elif $dry_run; then
    echo "  oidc: would turn on immutable subject"
  else
    gh api -X PUT "repos/$full/actions/oidc/customization/sub" --silent \
      --input - <<<'{"use_default":true,"use_immutable_subject":true}' || return
    echo "  oidc: turned on immutable subject"
  fi

  existing=$(gh secret list -R "$full" --json name --jq '.[].name') || return
  for name in "${names[@]}"; do
    var=secret_$name
    value=${!var:-}
    if ! $rotate && grep -qx "$name" <<<"$existing"; then
      echo "  secret $name: already set"
    elif [[ -z $value ]]; then
      echo "  secret $name: not in secrets file, skipped"
    elif $dry_run; then
      echo "  secret $name: would set"
    else
      # Through stdin so the value never appears in a process's arguments.
      printf '%s' "$value" | gh secret set "$name" -R "$full" || return
      echo "  secret $name: set"
    fi
  done

  branch=$(gh api "repos/$full" --jq .default_branch) || return
  if gh api "repos/$full/contents/$workflow_path?ref=$branch" --silent 2>/dev/null; then
    echo "  workflow: already on $branch"
  elif $dry_run; then
    echo "  workflow: would commit $workflow_path to $branch"
  else
    gh api -X PUT "repos/$full/contents/$workflow_path" --silent \
      -f message="ci: add Codex PR review" \
      -f branch="$branch" \
      -f content="$(base64 <"$template" | tr -d '\n')" || return
    echo "  workflow: committed $workflow_path to $branch"
  fi
}

load_secrets
if $all; then
  mapfile -t repos < <(gh repo list "$owner" --source --no-archived --limit 1000 \
    --json name --jq '.[].name | select(. != "workflows")')
fi

failed=()
for repo in "${repos[@]}"; do
  echo "$owner/$repo"
  setup_repo "$repo" || failed+=("$repo")
done
if ((${#failed[@]})); then
  echo "failed: ${failed[*]}" >&2
  exit 1
fi
