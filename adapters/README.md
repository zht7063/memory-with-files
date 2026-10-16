# MWF skill adapters

These entrypoints ship inside the MWF npm runtime. Use the
[recommended runtime installation](../README.md#recommended-installation),
which runs project setup and verifies the MCP connection. With the runtime
already installed, use its CLI:

```sh
mwf setup --root "/absolute/project" --harness codex --git-mode track
```

Here `mwf` means the CLI command printed by the installer, or a globally installed
`mwf` executable. Choose `ignore` for local-only memory and preserve existing
project settings. Use `--harness pi` or `--harness codex,pi` for installed Pi clients.

| Adapter | Role |
| --- | --- |
| [memory-with-files](memory-with-files/SKILL.md) | Recall, durable records and handoffs |
| [mwf-init](mwf-init/SKILL.md) | Explicit memory initialization with project and Git mode |
| [mwf-status](mwf-status/SKILL.md) | Connection/schema status and memory health |

These are runtime-managed resources, not three separate installation steps.
Setup owns their client deployment; copying the folders does not register MCP
or establish project bootstrap. Avoid deploying another `memory-with-files`
variant into the same discovery scope.

Upgrade the runtime and rerun setup to refresh adapters. Use `mwf detach --root
/absolute/project` to preview disconnection and add `--apply` to perform it.
Detach preserves project memory. See the [runtime guide](../README.md) for
verification, conflicts and lifecycle details.

The shared instruction source is the repository's
`skills/memory-with-files/SKILL.md`; this package's variant omits only its final
references paragraph. `npm run validate` from the source repository checks
synchronization. The other two adapters are independently maintained here.
