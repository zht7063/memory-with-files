<!-- memory-with-files:start -->
## Project memory (`.mwf`)

This project uses the `memory-with-files` protocol. When `.mwf/` exists:

- At the start or resumption of every task, read `.mwf/index.md` and `.mwf/handoff.md` before planning. Do not read the entire tree by default.
- Use the `memory-with-files` skill when available. If it is unavailable, follow `.mwf/protocol.md` conservatively: do not initialize a replacement memory system, invent record types or statuses, or perform schema migration, compaction, or conflict resolution from memory.
- Before acting on a relevant path, component, tool, operation, phase, file type, or keyword, load the matching detailed memory records routed by the index.
- When recalling an incident, preserve both where the workaround applies and where a previously failed approach may still be valid. Do not broaden a scoped failure into a global ban.
- Record durable user steering, important decisions and blockers, reusable multi-attempt failures or solutions, and milestone handoffs. Do not record routine progress or temporary instructions.
- With the skill, put ambiguous durable guidance in `candidates/` using a concrete record type and status `candidate`. Without the skill, append uncertain guidance to `.mwf/inbox.md`; do not invent candidate schema. Confirm it at the earliest useful checkpoint.
- Resolve authority in this order: current user instruction, formal project rules, verified code/runtime facts, confirmed active memory, historical memory. Ask the user before resolving a material ambiguity.
- Never store secrets, credentials, authentication material, or unrelated personal data in `.mwf`.
- Keep `.mwf/handoff.md` concise and update it when goals change, deliverables finish, blockers arise, or work is about to transfer to another session.
- If the skill is unavailable, limit structural writes to safe handoff/inbox updates and existing schema-conforming records. Preserve uncertain or conflicting records unchanged and ask the user rather than guessing.
<!-- memory-with-files:end -->
