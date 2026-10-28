<!-- memory-with-files:protocol:start -->
# Project memory protocol

This project uses `.mwf` for durable, project-local memory.

At the start of a task, read `index.md` and `handoff.md`, then load only records relevant to the task's paths, components, tools, operations, phase, file types, or keywords.

Authority order:

1. Current user instruction.
2. Formal project instructions and documentation.
3. Current code and verified runtime facts.
4. Confirmed active memory.
5. Historical or inactive memory.

Record durable user rules, accepted decisions, important blockers, reusable multi-attempt solutions, and concise handoffs. A candidate is not its own record type: use one of `preference`, `decision`, `incident`, `task`, or `knowledge` with `status: candidate`, and store it in `candidates/`. Do not store temporary coordination instructions, routine progress, secrets, credentials, or unrelated private data.

When the full skill is unavailable, degrade safely:

- do not create another memory directory or invent new types, statuses, or fields;
- put ambiguous input in `inbox.md` instead of constructing a candidate by guesswork;
- update `handoff.md` and existing schema-conforming records only when the change is unambiguous;
- preserve conflicts and possible duplicates unchanged for later maintenance;
- do not claim structural health unless the official doctor has run.

For every recalled incident, read the full record and preserve: the failed approach and reason, the successful approach and verification, where the workaround applies, where the old approach remains valid, and conditions that invalidate the workaround. This prevents a local failure from becoming an accidental global prohibition.

Users add manual input to `inbox.md`. Agents classify it into managed records and preserve processing provenance.

Use the `memory-with-files` skill when available for candidate creation, the complete schema, validation, maintenance, migration, compaction, and conflict procedures.
<!-- memory-with-files:protocol:end -->
