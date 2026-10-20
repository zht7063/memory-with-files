// Compatibility entrypoint: compose lifecycle callbacks outside the Core layer.
export * from "./core/index.js";
import { execute as executeCore, operateWithMigration } from "./core/index.js";
import { migrateIntegration } from "./lifecycle/migrate.js";
export function execute(
  ...[op, input, options]: Parameters<typeof executeCore>
) {
  return executeCore(op, input, { ...options, migrateIntegration });
}
export function operate(
  ...[tx, ...command]: Parameters<typeof import("./core/index.js").operate>
) {
  return operateWithMigration(tx, migrateIntegration, ...command);
}
