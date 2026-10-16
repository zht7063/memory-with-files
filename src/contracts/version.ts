import { readFileSync } from "node:fs";
export const RUNTIME_VERSION: string = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;
export const API_VERSION = 2;
