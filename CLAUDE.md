# CLAUDE.md

## Before pushing or opening a PR

Lint Rust code with clippy and fix every warning first. Use the same command CI runs:

```sh
cargo clippy --workspace --all-targets --locked -- -D warnings
```

Do not push or open a PR while clippy reports anything.
