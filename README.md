# MWF — Memory With Files (2.x)

MWF is a project-local wiki engine for coding agents. It stores pages as plain Markdown under `.mwf/` in your repository. This branch (`v2`) is the Rust rewrite. It is a new product and is not compatible with 1.x. Design docs are in [docs/](docs/README.md).

## Install

### Homebrew (macOS and Linux)

```sh
brew install zht7063/tap/mwf
```

The tap is [zht7063/homebrew-tap](https://github.com/zht7063/homebrew-tap). It gets stable releases only, starting with `2.0.0`. Prereleases such as `2.0.0-alpha.1` are published only on GitHub Releases.

### GitHub Release archives

Each [release](https://github.com/zht7063/memory-with-files/releases) has a `.tar.xz` archive for each supported platform, with a `.sha256` file for each archive:

| Platform | Archive |
| --- | --- |
| macOS, Apple silicon | `mwf-aarch64-apple-darwin.tar.xz` |
| macOS, Intel | `mwf-x86_64-apple-darwin.tar.xz` |
| Linux, x86_64 (static) | `mwf-x86_64-unknown-linux-musl.tar.xz` |
| Linux, arm64 (static) | `mwf-aarch64-unknown-linux-musl.tar.xz` |

Windows is not supported yet. To install from an archive, extract it and put `mwf` on your `PATH`:

```sh
tag=v2.0.0
target=x86_64-unknown-linux-musl
curl -LO "https://github.com/zht7063/memory-with-files/releases/download/$tag/mwf-$target.tar.xz"
curl -LO "https://github.com/zht7063/memory-with-files/releases/download/$tag/mwf-$target.tar.xz.sha256"
sha256sum -c "mwf-$target.tar.xz.sha256"   # on macOS: shasum -a 256 -c
tar xJf "mwf-$target.tar.xz"
install -m 755 "mwf-$target/mwf" ~/.local/bin/mwf
```

### Connect a coding agent

```sh
mwf install --host claude   # Claude Code
mwf install --host codex    # Codex
```

`install` adds MWF's hooks to the host's user-level hooks file and writes the `mwf` skill. Add `--dry-run` to see the changes first. For Codex, trust the mwf hooks in `/hooks` after installing. `mwf uninstall --host claude|codex` removes only what `install` added. See [docs/cli.md](docs/cli.md#宿主集成) for the files that each host uses.

Then run `mwf init` at the root of a git repository to create `.mwf/`.

## Development

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

Releases are built by [dist](https://github.com/axodotdev/cargo-dist) from `dist-workspace.toml`. `.github/workflows/release.yml` is generated: after you change the release config, run `dist generate` and commit the result. See [0054](docs/decisions/0054-release-config.md).

## License

MIT
