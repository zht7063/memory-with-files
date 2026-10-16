/** Narrow contract for the externally supplied Pi runtime used by acceptance checks.
 * Dynamic imports are checked at their export boundary; behavioral calls are exercised
 * against the real loader. This avoids bundling Pi or its internal types into MWF.
 */
import assert from "node:assert/strict";
export interface RegisteredTool {
  definition: {
    name: string;
    description: string;
    execute(
      id: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: undefined,
      context: unknown,
    ): Promise<unknown>;
  };
}
export interface PiRunner {
  bindCore(actions: object, context: object): void;
  onError(handler: (error: unknown) => void): void;
  emit(event: { type: string; reason?: string }): Promise<unknown>;
  emitInput(text: string, images: undefined, source: string): Promise<unknown>;
  getAllRegisteredTools(): RegisteredTool[];
  createContext(): unknown;
  emitBeforeAgentStart(
    prompt: string,
    images: undefined,
    system: string,
    options: { cwd: string },
  ): Promise<{ messages: { customType: string }[] } | undefined>;
}
interface Loader {
  loadExtensions(
    paths: string[],
    root: string,
  ): Promise<{ extensions: unknown; runtime: unknown; errors: unknown[] }>;
}
interface RunnerModule {
  ExtensionRunner: new (
    extensions: unknown,
    runtime: unknown,
    root: string,
    session: unknown,
    settings: object,
  ) => PiRunner;
}
interface SessionModule {
  SessionManager: { inMemory(root: string): unknown };
}
export function loaderModule(value: unknown): Loader {
  assert.ok(
    value &&
      typeof value === "object" &&
      "loadExtensions" in value &&
      typeof value.loadExtensions === "function",
    "Pi must export loadExtensions",
  );
  return value as Loader;
}
export function runnerModule(value: unknown): RunnerModule {
  assert.ok(
    value &&
      typeof value === "object" &&
      "ExtensionRunner" in value &&
      typeof value.ExtensionRunner === "function",
    "Pi must export ExtensionRunner",
  );
  return value as RunnerModule;
}
export function sessionModule(value: unknown): SessionModule {
  assert.ok(value && typeof value === "object" && "SessionManager" in value);
  const session = value.SessionManager;
  assert.ok(
    session &&
      (typeof session === "function" || typeof session === "object") &&
      "inMemory" in session &&
      typeof session.inMemory === "function",
    "Pi must export SessionManager.inMemory",
  );
  return value as SessionModule;
}
