#!/usr/bin/env bash
# Run on Linux with Docker, curl and Node. Uses public dummy IDs only.
set -euo pipefail

for tool in docker curl node mktemp; do
  command -v "$tool" >/dev/null || { printf 'Required tool is missing: %s\n' "$tool" >&2; exit 1; }
done

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
smoke_image="${1:-datatablemanager-smoke:local}"
policy_image="${2:-${smoke_image}-policy}"
temp_dir="$(mktemp -d)"
name_prefix="datatablemanager-smoke-$$-$RANDOM"
containers=()
smoke_network="$name_prefix-network"
smoke_volume="$name_prefix-policy"

cleanup() {
  local status=$?
  if ((status != 0)); then
    for name in "${containers[@]}"; do docker logs "$name" >&2 || true; done
  fi
  for name in "${containers[@]}"; do docker rm -f "$name" >/dev/null 2>&1 || true; done
  docker network rm "$smoke_network" >/dev/null 2>&1 || true
  docker volume rm "$smoke_volume" >/dev/null 2>&1 || true
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
  docker run -d --name "$name" --network "$smoke_network" "$@" "$smoke_image" >/dev/null
}

docker build --tag "$smoke_image" "$repo_dir"
docker build --tag "$policy_image" --file "$repo_dir/server/Dockerfile" "$repo_dir"
docker network create "$smoke_network" >/dev/null
docker volume create "$smoke_volume" >/dev/null

start_policy() {
  local name=$1
  containers+=("$name")
  docker run -d --name "$name" --network "$smoke_network" --network-alias policy \
    "${public_env[@]}" --mount "type=volume,source=$smoke_volume,target=/data" \
    --publish 127.0.0.1::3000 "$policy_image" >/dev/null
}

wait_policy() {
  local name=$1 port ready=false
  port="$(docker port "$name" 3000/tcp)"
  for ((attempt = 0; attempt < 40; attempt++)); do
    if curl --fail --silent --max-time 2 "http://$port/health" >"$temp_dir/policy-health.json"; then
      ready=true
      break
    fi
    sleep 0.25
  done
  [[ "$ready" == true ]] || fail 'Policy storage health check failed.'
  node --input-type=commonjs - "$temp_dir/policy-health.json" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.deepEqual(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), { status: 'ok' });
NODE
}

policy_name="$name_prefix-policy"
start_policy "$policy_name"
wait_policy "$policy_name"
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

policy_route="$base_url/api/column-access/cccccccc-cccc-cccc-cccc-cccccccccccc"
for method in GET PUT; do
  status="$(curl --silent --show-error --max-time 5 -X "$method" -D "$temp_dir/policy.headers" "$policy_route" -o "$temp_dir/policy-error.json" -w '%{http_code}')"
  [[ "$status" == 401 ]] || fail "Unauthenticated policy $method returned $status instead of 401."
  grep -Eiq '^cache-control:[[:space:]]*no-store' "$temp_dir/policy.headers" || fail 'Policy responses must not be cached.'
  node --input-type=commonjs - "$temp_dir/policy-error.json" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.equal(typeof JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).error, 'string');
NODE
done
node -e 'process.stdout.write("x".repeat(16385))' >"$temp_dir/oversize-body"
status="$(curl --silent --show-error --max-time 5 -X PUT --data-binary "@$temp_dir/oversize-body" "$policy_route" -o /dev/null -w '%{http_code}')"
[[ "$status" == 413 ]] || fail "Oversize policy body returned $status instead of 413."
printf 'Policy proxy: unauthenticated requests, no-store and request body limit passed.\n'

# Seed metadata without live Genesys credentials, then recreate the container.
# Authenticated API persistence and User PUT denial use mock transport in Node tests.
docker exec -i "$policy_name" node --input-type=commonjs <<'NODE'
const fs = require('node:fs');
const fixture = { version: 1, tables: {
  'cccccccc-cccc-cccc-cccc-cccccccccccc': {
    revision: 1, editableColumns: ['status'], schemaFingerprint: 'a'.repeat(64)
  }
} };
fs.writeFileSync('/data/column-access.json', JSON.stringify(fixture), { mode: 0o600 });
NODE
docker exec "$policy_name" cat /data/column-access.json >"$temp_dir/policy-before.json"
docker rm -f "$policy_name" >/dev/null
restarted_name="$name_prefix-policy-restarted"
start_policy "$restarted_name"
wait_policy "$restarted_name"
docker exec "$restarted_name" cat /data/column-access.json >"$temp_dir/policy-after.json"
cmp "$temp_dir/policy-before.json" "$temp_dir/policy-after.json" || fail 'Policy metadata changed across container recreation.'
proxy_ready=false
for ((attempt = 0; attempt < 80; attempt++)); do
  status="$(curl --silent --max-time 2 "$policy_route" -o /dev/null -w '%{http_code}' || true)"
  if [[ "$status" == 401 ]]; then proxy_ready=true; break; fi
  sleep 0.25
done
[[ "$proxy_ready" == true ]] || fail 'Nginx did not reconnect after policy container recreation.'
printf 'Policy storage: health and named volume persistence passed.\n'

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
