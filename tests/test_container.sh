#!/usr/bin/env bash
# Run on Linux with Docker, curl and Node. Uses public dummy IDs only.
set -euo pipefail

for tool in docker curl node mktemp; do
  command -v "$tool" >/dev/null || { printf 'Required tool is missing: %s\n' "$tool" >&2; exit 1; }
done

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
smoke_image="${1:-datatablemanager-smoke:local}"
temp_dir="$(mktemp -d)"
name_prefix="datatablemanager-smoke-$$-$RANDOM"
containers=()

cleanup() {
  local status=$?
  if ((status != 0)); then
    for name in "${containers[@]}"; do docker logs "$name" >&2 || true; done
  fi
  for name in "${containers[@]}"; do docker rm -f "$name" >/dev/null 2>&1 || true; done
  rm -rf -- "$temp_dir"
}
trap cleanup EXIT

fail() { printf '%s\n' "$*" >&2; exit 1; }

public_config=(
  GENESYS_CLIENT_ID=11111111-1111-1111-1111-111111111111
  GENESYS_REGION=eu_central_1
  GENESYS_ADMIN_GROUP_ID=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
  GENESYS_USER_GROUP_ID=BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB
)
public_env=()
for value in "${public_config[@]}"; do public_env+=(--env "$value"); done

start_container() {
  local name=$1
  shift
  containers+=("$name")
  docker run -d --name "$name" "$@" "$smoke_image" >/dev/null
}

docker build --tag "$smoke_image" "$repo_dir"
valid_name="$name_prefix-valid"
start_container "$valid_name" "${public_env[@]}" --publish 127.0.0.1::80
port="$(docker port "$valid_name" 80/tcp)"
base_url="http://$port"

ready=false
for ((attempt = 0; attempt < 40; attempt++)); do
  if curl --fail --silent --max-time 2 "$base_url/" >"$temp_dir/ready.html"; then
    ready=true
    break
  fi
  sleep 0.25
done
[[ "$ready" == true ]] || fail 'Valid public configuration did not start Nginx.'

curl --fail --silent --show-error --max-time 5 -D "$temp_dir/root.headers" "$base_url/" -o "$temp_dir/root.html"
grep -Eiq '^content-type:[[:space:]]*text/html([;[:space:]]|$)' "$temp_dir/root.headers" || fail 'Root response is not HTML.'
grep -Fq '<title>Data Table Manager</title>' "$temp_dir/root.html" || fail 'Root response is not the application.'

for asset in config main domain audit; do
  curl --fail --silent --show-error --max-time 5 -D "$temp_dir/$asset.headers" "$base_url/$asset.js" -o "$temp_dir/$asset.js"
  grep -Eiq '^content-type:[[:space:]]*(application|text)/(javascript|ecmascript)([;[:space:]]|$)' "$temp_dir/$asset.headers" || fail "$asset.js has an invalid JavaScript MIME type."
done
grep -Eiq '^cache-control:[[:space:]]*no-store' "$temp_dir/config.headers" || fail 'Generated public configuration must not be cached.'

node --input-type=commonjs - "$temp_dir/config.js" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(process.argv[2], 'utf8');
assert.doesNotMatch(source, /\$\{GENESYS_/);
const context = vm.createContext({ window: {} });
vm.runInContext(source, context);
assert.equal(Object.isFrozen(context.window.APP_CONFIG), true);
assert.deepEqual({ ...context.window.APP_CONFIG }, {
  clientId: '11111111-1111-1111-1111-111111111111',
  region: 'eu_central_1',
  adminGroupId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  userGroupId: 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB'
});
NODE
printf 'Valid configuration: rendered JavaScript, HTML and module MIME checks passed.\n'

expect_rejected() {
  local label=$1 expected=$2 override=$3 value
  local name="$name_prefix-$label"
  local rejected_env=()
  for value in "${public_config[@]}"; do
    if [[ "${value%%=*}" == "${override%%=*}" ]]; then value=$override; fi
    rejected_env+=(--env "$value")
  done
  start_container "$name" "${rejected_env[@]}"
  local running=true
  for ((attempt = 0; attempt < 40; attempt++)); do
    running="$(docker inspect --format '{{.State.Running}}' "$name")"
    [[ "$running" == true ]] || break
    sleep 0.25
  done
  [[ "$running" == false ]] || fail "$label unexpectedly kept running."
  [[ "$(docker inspect --format '{{.State.ExitCode}}' "$name")" == 1 ]] || fail "$label did not exit with the validation failure code."
  docker logs "$name" >"$temp_dir/$label.log" 2>&1
  grep -Fq "$expected" "$temp_dir/$label.log" || fail "$label did not report the expected validation failure."
  printf 'Rejected invalid startup: %s.\n' "$label"
}

uuid_error='Genesys client and group IDs must be UUIDs.'
groups_error='Admin and user group IDs must be different.'
expect_rejected invalid-client "$uuid_error" GENESYS_CLIENT_ID=invalid
expect_rejected invalid-admin-group "$uuid_error" GENESYS_ADMIN_GROUP_ID=invalid
expect_rejected invalid-user-group "$uuid_error" GENESYS_USER_GROUP_ID=
expect_rejected invalid-region 'GENESYS_REGION must be an SDK region key.' GENESYS_REGION=eu-central-1
expect_rejected identical-groups "$groups_error" GENESYS_USER_GROUP_ID=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
expect_rejected case-equivalent-groups "$groups_error" GENESYS_USER_GROUP_ID=AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA
printf 'Docker startup smoke tests passed.\n'
