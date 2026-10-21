# MWF skill adapters (legacy, not shipped)

Status: historical. These three folders were imported with the fixed 0.1.0
baseline (commit 12539fb) and have not been updated since. They are **not**
included in the 0.2.0 npm package (`package.json` `files` lists only
`assets/memory`, `assets/skills` and `assets/mwf-template/agents-block.md`)
and are not copied into the Codex plugin by `scripts/pack-release.ts`.

| Adapter                                         | Original role                                            |
| ----------------------------------------------- | -------------------------------------------------------- |
| [memory-with-files](memory-with-files/SKILL.md) | Recall, durable records and handoffs                     |
| [mwf-init](mwf-init/SKILL.md)                   | Explicit memory initialization with project and Git mode |
| [mwf-status](mwf-status/SKILL.md)               | Connection/schema status and memory health               |

Corrections relative to the earlier text of this file:

- `mwf setup` still exists but is deprecated; it only wraps `init` + `attach`.
  Use `mwf init --root /project --git-mode track|ignore`, then
  `mwf attach --root /project --harness pi|codex [--plugin-root PATH]`
  (preview) and repeat with `--apply`. `attach` takes one harness at a time;
  only `detach` accepts `--harness all`.
- The runtime-shipped skills are `assets/skills/setup/SKILL.md` (`mwf-setup`)
  and `assets/skills/mwf/SKILL.md` (`mwf`). See [install](../docs/install.md).
- There is no `npm run validate` script and no `skills/memory-with-files`
  directory in this repository; the previous synchronization note does not
  apply here.
- `mwf detach --root /project --harness pi|codex|all` previews; add `--apply`
  to perform it. Detach preserves project memory.
