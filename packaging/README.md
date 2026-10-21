# Packaging

`npm run pack:release` builds both install artifacts into `releases/`:

| Host  | Artifact                | Install                              | Details                            |
| ----- | ----------------------- | ------------------------------------ | ---------------------------------- |
| Codex | `mwf-codex-0.2.0.zip`   | see the Codex readme                 | [codex/readme.md](codex/readme.md) |
| Pi    | `zht7063-mwf-0.2.0.tgz` | `pi install ./zht7063-mwf-0.2.0.tgz` | [pi/README.md](pi/README.md)       |

Check both against `releases/SHA256SUMS` before installing. `RELEASE-STATUS.json` marks the build `publishable: false` until release acceptance is complete.
