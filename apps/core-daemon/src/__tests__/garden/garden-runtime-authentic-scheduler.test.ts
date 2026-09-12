import { describe, expect, it } from "vitest";
import { initDatabase } from "@do-soul/alaya-storage";
import { createGardenRuntime } from "../../garden/runtime/runtime.js";
import { createRuntimeInput } from "./runtime-fixture.js";

describe("createGardenRuntime with a real GardenScheduler", () => {
  it("persists a garden_tasks row after the background pass", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const runtime = createGardenRuntime(
        createRuntimeInput({
          databaseConnection: database.connection
        })
      );
      await runtime.runBackgroundPass();
      const rows = database.connection.prepare("SELECT id FROM garden_tasks").all() as readonly {
        readonly id: string;
      }[];
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });
});
