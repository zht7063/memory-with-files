// Host helpers for hooks: not tools (they are not in the tool list and no agent can call them).
// They pass straight through to the CLI layer so that hooks keep one dependency, `mcp/index.ts`.
export { confirmHost, getSession, setSession } from '../cli/index.ts';
export type {
  CliEnv,
  CliResult,
  ConfirmHostArgs,
  GetSessionData,
  SetSessionArgs,
} from '../cli/index.ts';
