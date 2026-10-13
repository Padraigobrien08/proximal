// Repository: shared helpers (ids, JSON columns, the record-order counter). Parameterised SQL only.
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type DB = Database.Database;

export const newId = () => randomUUID();

export const json = <T>(s: string | null): T => (s === null ? (null as T) : (JSON.parse(s) as T));

// ---------------------------------------------------------------- record order

/** Allocate the next shared record_order. Must be called inside the insertion transaction. */
export function nextRecordOrder(db: DB): number {
  const row = db.prepare("UPDATE record_counter SET value = value + 1 WHERE id = 1 RETURNING value").get() as {
    value: number;
  };
  return row.value;
}
