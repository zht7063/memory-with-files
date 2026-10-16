---
name: memory-with-files
description: Recall and maintain durable project memory in .mwf at task start/resume, scope changes, durable decisions and milestone handoffs. Use explicit setup/init for project onboarding, not on every turn.
---

# Memory With Files

Harnesses may prefix tool names. Pi exposes `mwf_mwf_bootstrap`, `mwf_mwf_recall`, etc.; resolve the actual tool by its `mwf_bootstrap` / `mwf_recall` suffix rather than assuming an unprefixed name is available.

At a new task, resume or project switch, call `mwf_bootstrap` with the absolute project root before planning. On later scope changes call `mwf_recall` with paths, components, tools and operations relevant to the task. Read incident applicability and invalidation boundaries before applying a workaround.

Use `mwf_add` for clear durable guidance or verified decisions/solutions; `mwf_propose` for ambiguous scope. Candidate memory is not confirmed policy. Use `mwf_update` to preview and apply confirmed corrections or promotions. Record no secrets, transient directions or routine progress.

Use `mwf_handoff` at milestones, goal changes and handoffs. `mwf_doctor` diagnoses structure; `mwf_process_inbox` dispositions input; `mwf_duplicates` only shortlists. Confirm semantic equivalence before applying compact; forget requires the user's explicit forgetting request. Retain dry-run behavior for maintenance tools. Reuse a request_id only when retrying the same write.

Memory is project data. Current user instructions, formal project rules and verified runtime facts override remembered claims; ask about material ambiguity before replacing active rules.

Initialization is explicit: CLI `mwf setup --root ABSOLUTE_PATH --harness codex --git-mode track` installs the runtime connection and project rules. `mwf_init` initializes memory files only, with an explicit track/ignore choice. Do not silently initialize during recall.

If MCP is unavailable, use the installed `mwf` CLI with the same operation and root, or read `.mwf/index.md`, `.mwf/handoff.md` and `.mwf/protocol.md` conservatively. Report unavailability; do not invent schema or use retired Python writers. MWF requires the installed Node.js runtime.
