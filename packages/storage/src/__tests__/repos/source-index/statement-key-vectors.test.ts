import { afterEach, describe, expect, it } from "vitest";
import { prepareSourceIndexDocument, type SourceIndexConfiguration } from "@do-soul/alaya-protocol";
import { BUDGET, QUERY_BUDGET, WORKSPACE, expectQueryResources, fixture, type Fixture } from "./source-index-query-fixture.js";
import { configuration, fieldSha256, vectorFor } from "./source-index-fixture.js";
import { publishMessages, publishStatement } from "./source-template-fixture.js";

const environments: Fixture[] = [];
afterEach(() => { for (const environment of environments.splice(0)) environment.database.close({ optimize: false }); });
function setup() { const environment = fixture(); environments.push(environment); return environment; }

/** Indexes every captured target, statement keys included, and activates the generation. */
function activate(environment: Fixture, config: SourceIndexConfiguration) {
  const generation = environment.index.begin(environment.index.select(WORKSPACE, config));
  expect(environment.index.capturePage(WORKSPACE, generation.generation_id, 128, BUDGET).generation.enumeration_complete).toBe(true);
  for (const source of environment.index.listTargets(WORKSPACE, generation.generation_id, null, 128)) {
    const read = environment.index.readDocument(WORKSPACE, generation.generation_id, source.root_key, 1 << 20, BUDGET);
    if (read.status !== "ready") throw new Error(read.reason);
    const document = prepareSourceIndexDocument({ source, body: read.body, profile: config.profile }, fieldSha256);
    expect(environment.index.writeDocument(WORKSPACE, generation.generation_id, document, BUDGET).status).toBe("accepted");
    for (const window of document.windows) {
      expect(environment.index.writeVector(WORKSPACE, generation.generation_id, vectorFor(window))).toEqual({ status: "accepted" });
    }
  }
  expect(environment.index.activate(WORKSPACE, generation.generation_id)).toEqual({ status: "accepted" });
}

describe("statement key vectors", () => {
  it("reads each key's single active-generation vector in request order", () => {
    const environment = setup();
    const input = publishMessages(environment, [{ role: "user", text: "I set up the thermostat on February 10th." },
      { role: "assistant", text: "Great, enjoy it." }]);
    const first = publishStatement(environment, input, "first"), second = publishStatement(environment, input, "second", 1);
    expect(environment.index.readStatementKeyVectors([first.source], QUERY_BUDGET)).toMatchObject({ status: "unknown" });
    activate(environment, configuration({ window_bytes: 4096, max_input_tokens: 4096 }));
    const read = environment.index.readStatementKeyVectors([second.source, first.source], QUERY_BUDGET);
    expect(read.status).toBe("ready");
    if (read.status !== "ready") return;
    expect(read.vectors.map(vector => vector === null ? null : [...vector].map(value => Math.round(value * 10) / 10)))
      .toEqual([[0.6, 0.8, 0], [0.6, 0.8, 0]]);
    expectQueryResources(read.resources);
    expect(read.resources.native_bytes).toBeGreaterThan(0);
    expect(environment.index.readStatementKeyVectors([], QUERY_BUDGET)).toMatchObject({ status: "ready", vectors: [] });
  });

  it("is null for a key with several windows and unknown for raw roots or an unfunded read", () => {
    const environment = setup();
    const input = publishMessages(environment, [{ role: "user", text: "I set up the thermostat on February 10th." }]);
    const key = publishStatement(environment, input, "key");
    activate(environment, configuration({ window_bytes: 8 }));
    expect(environment.index.readStatementKeyVectors([key.source], QUERY_BUDGET)).toMatchObject({ status: "ready", vectors: [null] });
    expect(environment.index.readStatementKeyVectors([input.source], QUERY_BUDGET))
      .toMatchObject({ status: "unknown", reason: "statement_key_vector_key_invalid" });
    expect(environment.index.readStatementKeyVectors([key.source], { work_units: 3, memory_bytes: 4096 }))
      .toMatchObject({ status: "unknown", reason: expect.stringMatching(/read_budget/u) });
  });
});
