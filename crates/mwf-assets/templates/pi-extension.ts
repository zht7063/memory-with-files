// mwf for pi: hands pi's events to `mwf hook <event> --host pi` (ADR 0055).
// Written by `mwf install --host pi`; `mwf uninstall --host pi` removes it. Edits are
// backed up and replaced on the next install.
//
// Every handler catches everything: when mwf is missing, slow or fails, pi carries on as if
// this extension did nothing (no context, no reminder, every tool allowed).

import { execFile } from "node:child_process";

const MWF: string = __MWF_PROGRAM__;
const TIMEOUT_MS = 10_000;

/** One `mwf hook` run: the JSON it prints, or `{}` on any failure. */
function hook(event: string, input: Record<string, unknown>): Promise<any> {
	return new Promise((resolve) => {
		try {
			const child = execFile(
				MWF,
				["hook", event, "--host", "pi"],
				{ timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
				(err, stdout) => {
					if (err) return resolve({});
					try {
						const v = JSON.parse(String(stdout));
						resolve(v && typeof v === "object" ? v : {});
					} catch {
						resolve({});
					}
				},
			);
			child.on("error", () => resolve({}));
			child.stdin?.on("error", () => {});
			child.stdin?.end(JSON.stringify(input));
		} catch {
			resolve({});
		}
	});
}

function context(out: any): string {
	const text = out?.hookSpecificOutput?.additionalContext;
	return typeof text === "string" ? text : "";
}

function notify(out: any, ctx: any): void {
	try {
		if (typeof out?.systemMessage === "string" && ctx?.hasUI) ctx.ui.notify(out.systemMessage, "warning");
	} catch {}
}

function session(ctx: any): string {
	try {
		return String(ctx.sessionManager.getSessionId() ?? "");
	} catch {
		return "";
	}
}

export default function (pi: any) {
	// Prompt ids are this load's prefix and a count: after /reload or a restart the count starts
	// again, so the prefix keeps a new prompt from reusing a turn mwf already reminded.
	const prefix = `${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
	let turns = 0;
	let promptId = "";
	// The session-start context waits for the next user prompt: pi takes messages there.
	let pendingSource: string | null = null;
	// Whether the current run was started by mwf's own Stop reminder.
	let reminded = false;

	pi.on("session_start", async (event: any) => {
		try {
			pendingSource = event?.reason === "reload" ? "startup" : String(event?.reason ?? "startup");
		} catch {}
	});

	pi.on("session_compact", async () => {
		try {
			pendingSource = "compact";
		} catch {}
	});

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		try {
			if (event?.messageType !== "user") return;
			turns += 1;
			promptId = `${prefix}-${turns}`;
			reminded = false;
			const base = { session_id: session(ctx), cwd: ctx.cwd };
			const parts: string[] = [];
			if (pendingSource !== null) {
				const out = await hook("session-start", { ...base, source: pendingSource });
				pendingSource = null;
				notify(out, ctx);
				parts.push(context(out));
			}
			const out = await hook("prompt", { ...base, prompt: String(event.prompt ?? "") });
			notify(out, ctx);
			parts.push(context(out));
			const content = parts.filter((p) => p !== "").join("\n\n");
			if (content === "") return;
			return { message: { customType: "mwf", content, display: false } };
		} catch {
			return;
		}
	});

	pi.on("agent_before_settle", async (event: any, ctx: any) => {
		try {
			// An aborted (Esc) or failed run is not continued.
			// The run the reminder started is not reminded again.
			if (event?.outcome !== "completed" || promptId === "" || reminded) return;
			const out = await hook("stop", {
				session_id: session(ctx),
				cwd: ctx.cwd,
				prompt_id: promptId,
				stop_hook_active: false,
			});
			const content = context(out);
			if (content === "") return;
			reminded = true;
			return { entries: [{ type: "custom_message", customType: "mwf", content, display: false }], continue: true };
		} catch {
			return;
		}
	});

	pi.on("tool_call", async (event: any, ctx: any) => {
		try {
			if (!["write", "edit", "bash"].includes(event?.toolName)) return;
			const out = await hook("pre-tool", {
				session_id: session(ctx),
				cwd: ctx.cwd,
				tool_name: event.toolName,
				tool_input: event.input,
			});
			const decision = out?.hookSpecificOutput;
			if (decision?.permissionDecision === "deny") {
				return { block: true, reason: String(decision.permissionDecisionReason ?? "mwf: refused") };
			}
		} catch {
			return;
		}
	});
}
