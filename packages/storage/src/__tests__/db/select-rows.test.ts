import { afterEach, describe, expect, it } from "vitest";
import { initDatabase, selectRows } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import {
  readNonEmptyStringField,
  readPositiveIntField,
  readRecord,
  type RowParser
} from "../../repos/shared/parse-row.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

const ProbeRowParser: RowParser<{ readonly name: string; readonly amount: number }> = {
  parse(value: unknown): { readonly name: string; readonly amount: number } {
    const record = readRecord(value, "probe row");
    return {
      name: readNonEmptyStringField(record, "name"),
      amount: readPositiveIntField(record, "amount")
    };
  }
};

describe("selectRows", () => {
  it("returns schema-checked rows and throws StorageError on a wrong column type", () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    database.connection.exec("CREATE TABLE probe (name TEXT NOT NULL, amount INTEGER NOT NULL)");
    database.connection.prepare("INSERT INTO probe (name, amount) VALUES (?, ?)").run("ok", 2);

    expect(selectRows(database.connection, "SELECT name, amount FROM probe", [], ProbeRowParser, "probe row"))
      .toEqual([{ name: "ok", amount: 2 }]);

    expect(() => selectRows(
      database.connection,
      "SELECT name, 'nope' AS amount FROM probe",
      [],
      ProbeRowParser,
      "probe row"
    )).toThrow(StorageError);
  });
});
