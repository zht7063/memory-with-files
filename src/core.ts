// Compatibility entrypoint: compose lifecycle callbacks outside the Core layer.
export * from "./core/index.js";
import { execute as executeCore, operateWithHooks } from "./core/index.js";
import { piConflicts } from "./integrations/pi/conflicts.js";
import { migrateIntegration } from "./lifecycle/migrate.js";
// Doctor reports the same host conflicts attach refuses on (issue #20).
const hostConflicts = Object.freeze({ pi: piConflicts });
export function execute(
  ...[op, input, options]: Parameters<typeof executeCore>
) {
  return executeCore(op, input, {
    ...options,
    migrateIntegration,
    hostConflicts,
  });
}
export function operate(
  ...[tx, ...command]: Parameters<typeof import("./core/index.js").operate>
) {
  return operateWithHooks(
    tx,
    { migrateIntegration, hostConflicts },
    ...command,
  );
}
