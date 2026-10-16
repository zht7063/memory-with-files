import { RUNTIME_VERSION, API_VERSION } from "./version.js";
import { MWFError } from "../storage/index.js";
export function failure(operation: string, root: string, error: unknown) {
  return {
    ok: false,
    operation,
    project_root: root,
    runtime_version: RUNTIME_VERSION,
    api_version: API_VERSION,
    schema_version: 1,
    changed_files: [],
    warnings: [],
    data: null,
    error: {
      code: error instanceof MWFError ? error.code : "IO_ERROR",
      ...(error instanceof MWFError && error.details
        ? { details: error.details }
        : {}),
      message:
        error instanceof MWFError
          ? error.message
          : "Operation failed; inspect local environment.",
    },
  };
}
