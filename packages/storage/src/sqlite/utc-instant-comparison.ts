import { compareUtcInstants, utcInstantOrderKey } from "@do-soul/alaya-protocol";
import type { SqliteConnection } from "./db.js";

export function registerUtcInstantComparison(connection: SqliteConnection): void {
  connection.function("alaya_utc_order_key", { deterministic: true }, (value: unknown) => {
    const key = typeof value === "string" ? utcInstantOrderKey(value) : undefined;
    if (key === undefined) throw new Error("invalid UTC instant in current-source index");
    return key;
  });
  connection.function(
    "alaya_utc_compare",
    { deterministic: true },
    (left: unknown, right: unknown) =>
      typeof left === "string" && typeof right === "string"
        ? compareUtcInstants(left, right) ?? null
        : null
  );
}
