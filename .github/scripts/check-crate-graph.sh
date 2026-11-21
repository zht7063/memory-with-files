#!/usr/bin/env bash
# Asserts that the dependencies between workspace crates (from `cargo metadata`)
# are exactly the edges of the Mermaid graph in docs/architecture.md.
# Node ids map to crate names: `bin` -> `mwf`, any other `<id>` -> `mwf-<id>`.
set -euo pipefail
cd "$(dirname "$0")/../.."

expected=$(
  sed -n '/^```mermaid/,/^```/p' docs/architecture.md |
    grep -E '^[[:space:]]*[a-z]+[[:space:]]*-->[[:space:]]*[a-z]+[[:space:]]*$' |
    awk -F'-->' '{ gsub(/[[:space:]]/, ""); print $1, $2 }' |
    awk '{ for (i = 1; i <= 2; i++) $i = ($i == "bin") ? "mwf" : "mwf-" $i; print $1 " -> " $2 }' |
    sort -u
)

# Every dependency kind counts, dev-dependencies included.
actual=$(
  cargo metadata --format-version 1 --no-deps --offline |
    jq -r '
      (.packages | map(.name)) as $ws
      | .packages[]
      | .name as $from
      | .dependencies[]
      | select(.name as $n | $ws | index($n))
      | "\($from) -> \(.name)"' |
    sort -u
)

if [ -z "$expected" ]; then
  echo "error: no edges found in the mermaid graph of docs/architecture.md" >&2
  exit 1
fi
if [ "$expected" != "$actual" ]; then
  echo "error: workspace crate graph differs from docs/architecture.md" >&2
  diff <(echo "$expected") <(echo "$actual") --label docs/architecture.md --label 'cargo metadata' -u >&2 || true
  exit 1
fi
echo "crate graph matches docs/architecture.md ($(echo "$expected" | wc -l | tr -d ' ') edges)"
