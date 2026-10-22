// Package entrypoint: compose host callbacks outside the Core layer.
export * from "./core/index.js";
import { execute as executeCore, operateWithHooks } from "./core/index.js";
import { hostIssues } from "./integrations/registry.js";
// Host checks for status/doctor come from the adapters via the registry;
// doctor also reports the conflicts attach refuses on (issue #20).
export function execute(
  ...[op, input, options]: Parameters<typeof executeCore>
) {
  return executeCore(op, input, {
    ...options,
    hostIssues,
  });
}
export function operate(
  ...[tx, ...command]: Parameters<typeof import("./core/index.js").operate>
) {
  return operateWithHooks(tx, { hostIssues }, ...command);
}
