# Packaging

`npm run pack:release` builds both install artifacts into `releases/`:

| Host  | Artifact                | Install                                  | Details                            |
| ----- | ----------------------- | ---------------------------------------- | ---------------------------------- |
| Codex | `mwf-codex-0.3.0.zip`   | see the Codex readme                     | [codex/readme.md](codex/readme.md) |
| Pi    | `zht7063-mwf-0.3.0.tgz` | extract, then `pi install <package dir>` | [pi/README.md](pi/README.md)       |

Check both against `releases/SHA256SUMS` before installing. `RELEASE-STATUS.json` computes `publishable` from Linux CLI harness evidence (criteria `linux-cli-harness/1`, see [release criteria](../docs/release-criteria.md)); missing or failing evidence yields `false`. The criteria changed in 0.3.0: desktop, macOS, performance and real-host verification are no longer release gates and remain unverified.

Run `npm ci` (real `node_modules`, not a symlink) before packing so `npm pack` includes transitive deps of `bundleDependencies`.

To uninstall or detach, and for the full list of files MWF and its hosts write, see [UNINSTALL.md](UNINSTALL.md).
