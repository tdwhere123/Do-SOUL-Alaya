import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SOURCE_STATEMENTS_CONTRACT } from "@do-soul/alaya-protocol";
import { SqliteMemoryEntryRepo } from "@do-soul/alaya-storage";
import { STATEMENT_SESSION_IDLE_MS } from "../../garden/statement-session/statement-session-closure.js";
import { RUN, createStatementSessionEnvironment } from "./statement-session-fixture.js";

const ASSERTION = "Alice uses tools.";
const LONG_ASSERTION = `${"The archive retains neutral context. ".repeat(26)}${ASSERTION}`;

const previousFetch = globalThis.fetch;

describe("ordinary extraction source statement adapters", () => {
  beforeEach(() => {
    globalThis.fetch = async () => { throw new Error("provider network forbidden in ordinary extraction publication"); };
  });
  afterEach(() => { globalThis.fetch = previousFetch; });

  it("runs the production post-turn entry through session parsing and SQLite publication with retries", async () => {
    const environment = await createStatementSessionEnvironment();
    try {
      const report = () => environment.report(0, [{ role: "user", content_excerpt: LONG_ASSERTION }]);
      await report(); await report();
      await environment.processPostTurn();
      const provider = environment.provider(text => text.includes(ASSERTION) ? [{ text: ASSERTION, relation: "tool usage" }] : []);
      await environment.processSession(provider);
      expect(environment.sessionTasks()).toEqual([]);
      environment.advance(STATEMENT_SESSION_IDLE_MS);
      await environment.processSession(provider);
      await report(); await environment.processPostTurn(); await environment.processSession(provider);
      expect(environment.sessionTasks().map(row => row.status)).toEqual(["completed"]);
      expect(environment.requests).toHaveLength(1);

      const memories = environment.database.connection.prepare("SELECT object_id FROM memory_entries").all() as { object_id: string }[];
      expect(memories).toHaveLength(1);
      const signals = await environment.signalService.listByRun(RUN);
      expect(signals.find((signal) => signal.interpretation_contract === SOURCE_STATEMENTS_CONTRACT)).toMatchObject({
        source: "garden_compile", object_kind: null, confidence: null, interpretation_contract: SOURCE_STATEMENTS_CONTRACT
      });
      const published = await environment.memoryService.findById(memories[0]!.object_id);
      expect(published).toMatchObject({ dimension: "observation", confidence: null, content: expect.stringContaining(ASSERTION) });
      expect(environment.database.connection.prepare("SELECT count(*) AS n FROM claim_forms").get()).toMatchObject({ n: 0 });

      const reopened = await new SqliteMemoryEntryRepo(environment.reopen()).findById(published!.object_id);
      expect(reopened).toMatchObject({ object_id: published!.object_id, dimension: "observation", confidence: null });
    } finally {
      await environment.close();
    }
  });
});
