import { compareUtcInstants } from "@do-soul/alaya-protocol";
import type { SqliteConnection } from "./db.js";

export function registerUtcInstantComparison(connection: SqliteConnection): void {
  connection.function(
    "alaya_utc_compare",
    { deterministic: true },
    (left: unknown, right: unknown) =>
      typeof left === "string" && typeof right === "string"
        ? compareUtcInstants(left, right) ?? null
        : null
  );
}
