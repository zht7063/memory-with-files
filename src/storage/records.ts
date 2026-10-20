import { MWFError, Transaction } from "./index.js";
import {
  RECORD_DIRS,
  parseRecord,
  validateRecord,
  type MemoryRecord,
} from "../contracts/records.js";
export function records(tx: Transaction, archive = false): MemoryRecord[] {
  return (archive ? [...RECORD_DIRS, "archive"] : RECORD_DIRS).flatMap((dir) =>
    tx
      .files(`.mwf/${dir}`)
      .filter((p) => p.endsWith(".md"))
      .map((p) => parseRecord(p, tx.get(p)!)),
  );
}
export function validRecords(tx: Transaction, archive = false) {
  const result = records(tx, archive);
  const ids = new Set<string>();
  for (const r of result) {
    const errors = validateRecord(r);
    if (errors.length)
      throw new MWFError("INVALID_RECORD", `${r.path}: ${errors.join(", ")}`);
    if (ids.has(r.metadata.id))
      throw new MWFError(
        "DUPLICATE_ID",
        `Duplicate ID ${r.metadata.id}; run doctor.`,
      );
    ids.add(r.metadata.id);
  }
  return result;
}
