---
name: mwf-setup
description: Explicitly initialize, attach, rebind, diagnose or detach project file memory.
---
Use the runtime shipped with this installed package. Do not use an unknown global MWF.
1. Resolve the explicit project root. Run status. Installation does not enable projects.
2. For new data, ask for track/ignore Git mode if not already specified, then run init.
3. For old integration, preview migrate --from 0.1. Stop old sessions and integrations before --legacy-stopped --apply. Do not remove unowned resources.
4. Preview attach --harness codex|pi. For Codex pass --plugin-root pointing to this plugin. Apply only the requested integration. Reload the host and check real tools.
5. After upgrades run rebind from the new installed package, then reload.
6. To stop integration run detach --harness codex|pi --apply. Inspect cleanup conflicts. Keep memory and handoffs. Uninstall the host package separately.
Never write project rules or enable another project automatically. Do not mark a connection ready from a configuration write alone.
