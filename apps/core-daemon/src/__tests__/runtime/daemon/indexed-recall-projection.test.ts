import { afterEach, describe, expect, it } from "vitest";
import { initDatabase, type StorageDatabase } from "@do-soul/alaya-storage";
import { createDaemonRepositories } from "../../../runtime/daemon/wiring/daemon-repositories.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("daemon indexed recall projection composition", () => {
  it("prepares the candidate index family at repository composition", () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    createDaemonRepositories({ database, warn: () => undefined });
    expect(database.connection.prepare("SELECT revision FROM garden_semantic_schema").all())
      .toEqual([{ revision: 5 }]);
    expect(database.connection.prepare(
      "SELECT name FROM sqlite_master WHERE name='garden_index_revisions'"
    ).get()).toEqual({ name: "garden_index_revisions" });
  });
});
