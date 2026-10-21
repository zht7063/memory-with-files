import { z } from "zod";

// Local subprocess results and CLI trust bypasses cannot close a desktop criterion.
export const desktopScenarios = {
  environment: ["desktop_environment"],
  discovery: ["normal_install", "normal_trust_reload", "unenabled_project"],
  failures: ["mcp_delayed", "mcp_failed", "hooks_disabled", "hooks_untrusted"],
  paths: [
    "copied_project",
    "unicode_space_path",
    "subdirectory",
    "deleted_runtime",
  ],
  request: [
    "request_v1",
    "request_v2_compact",
    "request_v2_resume",
    "request_v2_clear",
  ],
} as const;
const observation = z.object({
  status: z.enum(["pass", "fail", "partial", "not_run"]),
  source: z.enum(["desktop", "local", "bundled_cli", "none"]),
  artifacts: z.array(z.string().min(1)),
  trust_bypass: z.boolean(),
  expected_version: z.string().optional(),
  observed_version: z.string().optional(),
  observation_method: z.string().optional(),
});
export const desktopEvidence = z
  .object({
    task: z.literal("T08"),
    environment: z.object({
      desktop_build: z.string().nullable(),
      os: z.string().nullable(),
      gui_node_path: z.string().nullable(),
      gui_node_version: z.string().nullable(),
      installation: z.string().nullable(),
      trust: z.string().nullable(),
      reload: z.string().nullable(),
      artifact_sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
    }),
    scenarios: z.record(observation),
  })
  .superRefine((evidence, ctx) => {
    for (const name of Object.values(desktopScenarios).flat()) {
      const row = evidence.scenarios[name];
      const reject = (message: string) =>
        ctx.addIssue({ code: "custom", path: ["scenarios", name], message });
      if (!row) {
        reject("Required T08 scenario missing");
        continue;
      }
      if (row.status !== "pass") continue;
      if (row.source !== "desktop" || row.trust_bypass || !row.artifacts.length)
        reject(
          "Desktop pass needs normal host observation and artifacts; bypass/local evidence is partial only",
        );
      if (Object.values(evidence.environment).some((value) => !value))
        reject("Desktop environment and candidate SHA256 must be recorded");
      if (
        name.startsWith("request_") &&
        (!row.expected_version ||
          row.expected_version !== row.observed_version ||
          !row.observation_method)
      )
        reject(
          "Request pass needs matching content version and host-supported observation method",
        );
    }
  });
export function summarizeDesktop(input: unknown) {
  const evidence = desktopEvidence.parse(input);
  const criteria = Object.fromEntries(
    Object.entries(desktopScenarios).map(([criterion, names]) => {
      const rows = names.map((name) => evidence.scenarios[name]);
      return [
        criterion,
        rows.some((row) => row.status === "fail")
          ? "fail"
          : rows.every((row) => row.status === "pass")
            ? "pass"
            : rows.every((row) => row.status === "not_run")
              ? "not_run"
              : "partial",
      ];
    }),
  );
  return {
    task: "T08",
    criteria,
    status: Object.values(criteria).some((status) => status === "fail")
      ? "fail"
      : Object.values(criteria).every((status) => status === "pass")
        ? "pass"
        : Object.values(criteria).every((status) => status === "not_run")
          ? "not_run"
          : "partial",
    release_eligible: false,
  };
}
