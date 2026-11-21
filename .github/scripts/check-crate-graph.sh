#!/usr/bin/env bash
# Asserts that the workspace crates and the dependencies between them (from
# `cargo metadata`) are exactly the nodes and edges of the topology diagram, the
# first Mermaid block in docs/architecture.md.
# Node ids map to crate names: `bin` -> `mwf`, any other `<id>` -> `mwf-<id>`.
# The diagram may hold only the line forms parsed below; anything else, such as
# another arrow style or a trailing `;`, is an error rather than skipped.
set -euo pipefail
cd "$(dirname "$0")/../.."
doc=docs/architecture.md

# Prints "node <crate>" and "edge <crate> -> <crate>" lines.
parsed=$(
  awk '
    function crate(id) { return id == "bin" ? "mwf" : "mwf-" id }
    function bad(why) { printf "error: %s:%d: %s: %s\n", FILENAME, FNR, why, $0 > "/dev/stderr"; status = 1 }
    !inside && /^```mermaid[[:space:]]*$/ { inside = 1; header = 1; next }
    !inside { next }
    /^```[[:space:]]*$/ { closed = 1; exit }
    header { header = 0; if ($0 !~ /^(flowchart|graph)[[:space:]]+(TD|TB|BT|LR|RL)[[:space:]]*$/) bad("unsupported diagram header"); next }
    /^[[:space:]]*$/ || /^[[:space:]]*%%/ { next }
    /^[[:space:]]*subgraph[[:space:]]+[a-z]+(\["[^"]*"\])?[[:space:]]*$/ || /^[[:space:]]*end[[:space:]]*$/ { next }
    /^[[:space:]]*[a-z]+\["[^"]*"\][[:space:]]*$/ {
      sub(/^[[:space:]]*/, ""); sub(/\[.*/, ""); print "node " crate($0); next
    }
    /^[[:space:]]*[a-z]+[[:space:]]*-->[[:space:]]*[a-z]+[[:space:]]*$/ {
      gsub(/[[:space:]]/, ""); split($0, ends, "-->")
      print "node " crate(ends[1]); print "node " crate(ends[2])
      print "edge " crate(ends[1]) " -> " crate(ends[2]); next
    }
    { bad("unsupported line in the topology diagram") }
    END {
      if (!inside) { print "error: no mermaid block in " FILENAME > "/dev/stderr"; status = 1 }
      else if (!closed) { print "error: unclosed mermaid block in " FILENAME > "/dev/stderr"; status = 1 }
      exit status
    }
  ' "$doc"
)
expected_nodes=$(sed -n 's/^node //p' <<<"$parsed" | sort -u)
expected_edges=$(sed -n 's/^edge //p' <<<"$parsed" | sort -u)

# Edges come from Cargo's resolved graph with all features on, so a dependency
# counts when Cargo resolves it to a workspace member by package ID: through a
# path, `workspace = true`, or `[patch]`, but not an outside package with a
# member's name. Every dependency kind counts, dev-dependencies included, on
# every target platform.
metadata=$(cargo metadata --format-version 1 --all-features)
actual_nodes=$(jq -r '.workspace_members as $ws | .packages[] | select(.id as $id | $ws | index($id)) | .name' <<<"$metadata" | sort -u)
actual_edges=$(
  jq -r '
    .workspace_members as $ws
    | (.packages | map({ key: .id, value: .name }) | from_entries) as $names
    | .resolve.nodes[]
    | select(.id as $id | $ws | index($id))
    | $names[.id] as $from
    | .deps[]
    | select(.pkg as $pkg | $ws | index($pkg))
    | "\($from) -> \($names[.pkg])"' <<<"$metadata" |
    sort -u
)

if [ -z "$expected_edges" ]; then
  echo "error: no edges found in the topology diagram of $doc" >&2
  exit 1
fi
status=0
if [ "$expected_nodes" != "$actual_nodes" ]; then
  echo "error: workspace crates differ from the nodes of the topology diagram in $doc" >&2
  diff <(echo "$expected_nodes") <(echo "$actual_nodes") --label "$doc" --label 'cargo metadata' -u >&2 || true
  status=1
fi
if [ "$expected_edges" != "$actual_edges" ]; then
  echo "error: workspace crate graph differs from the topology diagram in $doc" >&2
  diff <(echo "$expected_edges") <(echo "$actual_edges") --label "$doc" --label 'cargo metadata' -u >&2 || true
  status=1
fi
[ "$status" -eq 0 ] || exit 1
echo "crate graph matches $doc ($(wc -l <<<"$expected_nodes" | tr -d ' ') crates, $(wc -l <<<"$expected_edges" | tr -d ' ') edges)"
