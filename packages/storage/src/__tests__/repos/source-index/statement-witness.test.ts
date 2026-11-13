import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { warmCjkSegmentation } from "@do-soul/alaya-cjk-segmentation";
import { QUERY_BUDGET, expectQueryResources, fixture, publishIndexed, type Fixture } from "./source-index-query-fixture.js";
import { WORKSPACE } from "./source-index-fixture.js";
import { publishMessages, publishStatement } from "./source-template-fixture.js";

const environments: Fixture[] = [];
afterEach(() => { for (const environment of environments.splice(0)) environment.database.close({ optimize: false }); });
beforeAll(async () => { expect(await warmCjkSegmentation()).toBe(true); });
function setup() { const environment = fixture(); environments.push(environment); return environment; }

describe("statement key witnesses", () => {
  it("reads each key's host role and anchor tokens from its key text and raw message", () => {
    const environment = setup();
    const input = publishMessages(environment, [{ role: "user", text: "I met Rachel in Miami." },
      { role: "assistant", text: "你在上海买了咖啡机。" }]);
    const named = publishStatement(environment, input, "named");
    const rewritten = publishStatement(environment, input, "rewritten", 0, { statement: { text: "I took a Coastal trip.", relation: "trip" } });
    const assistant = publishStatement(environment, input, "assistant", 1);
    const anchors = ["Rachel", "rachel MIAMI", "Coastal", "Paris", "上海", "咖啡机", "北京"];
    const read = environment.index.readStatementWitnesses(input.source, [named.source, rewritten.source, assistant.source], anchors, QUERY_BUDGET);
    expect(read).toMatchObject({ status: "ready", session_time: null, witnesses: [
      { role: "user", anchors: [true, true, false, false, false, false, false], statement: "I met Rachel in Miami.\nreported event" },
      // The rewritten key keeps its message's names and adds its own.
      { role: "user", anchors: [true, true, true, false, false, false, false], statement: "I took a Coastal trip.\ntrip" },
      { role: "assistant", anchors: [false, false, false, false, true, true, false], statement: "你在上海买了咖啡机。\nreported event" }] });
    expectQueryResources(read.resources);
    expect(read.resources.native_bytes).toBeGreaterThan(0);
    const unkeyed = environment.index.readStatementWitnesses(input.source, [], anchors, QUERY_BUDGET);
    expect(unkeyed).toMatchObject({ status: "ready", witnesses: [], inventory: { status: "captured", inventory: input.inventory } });
    expect(unkeyed.resources.native_bytes).toBeGreaterThan(0);
  });

  it("returns the root's recorded event time as the session time", () => {
    const environment = setup();
    const input = publishMessages(environment, [{ role: "user", text: "Last Saturday I ran a 5K." }], "timed", WORKSPACE,
      "2023-03-06T10:00:00.000Z");
    const read = environment.index.readStatementWitnesses(input.source, [publishStatement(environment, input, "timed").source], [], QUERY_BUDGET);
    expect(read).toMatchObject({ status: "ready", session_time: "2023-03-06T10:00:00.000Z",
      witnesses: [{ role: "user", anchors: [], statement: "Last Saturday I ran a 5K.\nreported event" }] });
  });

  it("keeps unkeyed physical messages and distinguishes captured-empty, unknown, unavailable and limited inventory", () => {
    const environment = setup();
    const input = publishMessages(environment, [{ role: "user", text: "Unkeyed prompt." },
      { role: "assistant", text: "Keyed answer." }, { role: "user", text: "Unkeyed tail." }]);
    const key = publishStatement(environment, input, "answer-only", 1);
    expect(environment.index.readStatementWitnesses(input.source, [key.source], [], QUERY_BUDGET))
      .toMatchObject({ status: "ready", inventory: { status: "captured", inventory: input.inventory },
        witnesses: [{ role: "assistant" }] });
    const empty = publishMessages(environment, [], "empty-inventory");
    expect(environment.index.readStatementWitnesses(empty.source, [], [], QUERY_BUDGET))
      .toMatchObject({ status: "ready", inventory: { status: "captured", inventory: { occurrences: [] } } });
    const unknown = publishIndexed(environment, "No captured inventory.", "unknown-inventory");
    expect(environment.index.readStatementWitnesses(unknown.source, [], [], QUERY_BUDGET))
      .toMatchObject({ status: "ready", inventory: { status: "unknown" } });
    expect(environment.index.readStatementWitnesses(input.source, [], [], { work_units: 0, memory_bytes: 0 }))
      .toMatchObject({ status: "ready", inventory: { status: "resource_limited" } });
    environment.database.connection.prepare("DELETE FROM source_host_inventories WHERE record_id=?").run(input.record.record_id);
    expect(environment.index.readStatementWitnesses(input.source, [], [], QUERY_BUDGET))
      .toMatchObject({ status: "ready", inventory: { status: "unavailable" } });
  });

  it("is unknown for raw roots, keys of different roots, and an unfunded read", () => {
    const environment = setup();
    const input = publishMessages(environment, [{ role: "user", text: "I met Rachel in Miami." }]);
    const other = publishMessages(environment, [{ role: "user", text: "Another root." }], "other-root");
    const key = publishStatement(environment, input, "key"), foreign = publishStatement(environment, other, "foreign");
    expect(environment.index.readStatementWitnesses(input.source, [input.source], [], QUERY_BUDGET))
      .toMatchObject({ status: "unknown", reason: "statement_witness_key_root_mismatch" });
    expect(environment.index.readStatementWitnesses(input.source, [key.source, foreign.source], [], QUERY_BUDGET))
      .toMatchObject({ status: "unknown", reason: "statement_witness_key_root_mismatch" });
    expect(environment.index.readStatementWitnesses(input.source, [key.source], ["Rachel"], { work_units: 40, memory_bytes: 4096 }))
      .toMatchObject({ status: "unknown", reason: expect.stringMatching(/read_budget|source_template_host_resource_limited/u) });
  });

  it("is unknown when the key's message span is not a host message", () => {
    const environment = setup();
    const input = publishMessages(environment, [{ role: "user", text: "I met Rachel in Miami." }]);
    const key = publishStatement(environment, input, "key");
    const shifted = { ...key.source, auxiliary: { ...key.source.auxiliary!, source_span: [0, 4] as const } };
    expect(environment.index.readStatementWitnesses(input.source, [shifted], ["Rachel"], QUERY_BUDGET))
      .toMatchObject({ status: "unknown", reason: "statement_witness_message_binding" });
  });
});
