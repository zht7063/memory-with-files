#!/usr/bin/env bash
# Regression tests for check-crate-graph.sh: each case copies the repository to a
# temporary directory, changes the docs or the manifests, and asserts whether the
# check passes or fails.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
failures=0

# Usage: run_case <name> <pass|fail> <setup function>
run_case() {
  local name=$1 want=$2 setup=$3 dir="$tmp/$1" got
  mkdir -p "$dir/repo"
  (cd "$root" && cp -R Cargo.toml Cargo.lock rust-toolchain.toml crates docs .github "$dir/repo/")
  (cd "$dir/repo" && "$setup" "$dir")
  if "$dir/repo/.github/scripts/check-crate-graph.sh" >"$dir/out" 2>&1; then got=pass; else got=fail; fi
  if [ "$got" = "$want" ]; then
    echo "ok: $name ($got: $(grep -m 1 -E '^(error|crate graph)' "$dir/out"))"
  else
    echo "FAILED: $name: want $want, got $got" >&2
    sed 's/^/  /' "$dir/out" >&2
    failures=$((failures + 1))
  fi
}

unchanged() { :; }

# A package outside the workspace that is also named mwf-domain is not the member.
outside_same_name() {
  mkdir -p "$1/outside/mwf-domain/src"
  touch "$1/outside/mwf-domain/src/lib.rs"
  printf '[package]\nname = "mwf-domain"\nversion = "0.1.0"\nedition = "2024"\n' \
    >"$1/outside/mwf-domain/Cargo.toml"
  sed -i.bak 's|^mwf-domain.workspace = true$|mwf-domain = { path = "../../../outside/mwf-domain" }|' \
    crates/mwf-store/Cargo.toml
  grep -q outside crates/mwf-store/Cargo.toml
}

# A version-only dev-dependency that [patch.crates-io] resolves to the member.
patched_dev_dependency() {
  printf '\n[dev-dependencies]\nmwf-domain = "2.0.0-alpha.0"\n' >>crates/mwf-search/Cargo.toml
  printf '\n[patch.crates-io]\nmwf-domain = { path = "crates/mwf-domain" }\n' >>Cargo.toml
}

# An optional dependency that only a feature turns on.
optional_dependency() {
  printf '\n[dependencies]\nmwf-domain = { workspace = true, optional = true }\n' >>crates/mwf-search/Cargo.toml
}

# Mermaid accepts a trailing semicolon, so this is an edge the crates do not have.
edge_with_semicolon() {
  sed -i.bak 's|^    store --> domain$|&\n    cli --> store;|' docs/architecture.md
  grep -q 'cli --> store;' docs/architecture.md
}

# A plain edge the crates do not have.
undeclared_edge() {
  sed -i.bak 's|^    store --> domain$|&\n    cli --> store|' docs/architecture.md
  grep -q 'cli --> store' docs/architecture.md
}

# Edges in another diagram are not part of the topology.
edge_in_other_diagram() {
  # shellcheck disable=SC2016 # literal Markdown fences
  printf '\n```mermaid\nflowchart TD\n    cli --> store\n```\n' >>docs/architecture.md
}

# A workspace crate that the diagram does not show, even with no edges.
crate_not_in_diagram() {
  mkdir -p crates/mwf-extra/src
  touch crates/mwf-extra/src/lib.rs
  printf '[package]\nname = "mwf-extra"\nversion = "2.0.0-alpha.0"\nedition = "2024"\n' \
    >crates/mwf-extra/Cargo.toml
}

# A diagram node that is not a workspace crate, even with no edges.
node_not_in_workspace() {
  sed -i.bak 's|^    assets\["|    extra["mwf-extra"]\n&|' docs/architecture.md
  grep -q 'extra\["mwf-extra"\]' docs/architecture.md
}

run_case unchanged pass unchanged
run_case outside-same-name fail outside_same_name
run_case patched-dev-dependency fail patched_dev_dependency
run_case optional-dependency fail optional_dependency
run_case edge-with-semicolon fail edge_with_semicolon
run_case undeclared-edge fail undeclared_edge
run_case edge-in-other-diagram pass edge_in_other_diagram
run_case crate-not-in-diagram fail crate_not_in_diagram
run_case node-not-in-workspace fail node_not_in_workspace

if [ "$failures" -ne 0 ]; then
  echo "$failures case(s) failed" >&2
  exit 1
fi
