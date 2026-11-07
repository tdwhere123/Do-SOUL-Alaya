import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());
import { RecallService, capableRecallConsumerDeclaration } from "@do-soul/alaya-core";
import { SOURCE_TEMPLATE_PROPOSAL_PRODUCER_ID, QUESTION_TIME_PROPOSAL_PRODUCER_ID,
  SoulMemorySearchResponseSchema } from "@do-soul/alaya-protocol";
import { fixture as storageFixture } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { publishMessages, publishStatement } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-template-fixture.js";
import { createDependencies } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { CLOCK, WS, digest, withIndexedSources, SIMULATED_CONFIGURATION } from "./source-semantic-index-acquisition.test-support.js";

const originalText = "needle I finally beat the Dark Souls 3 DLC last weekend, after weeks of trying.";
const originals = Array.from({ length: 16 }, (_, index) => ({ id: `original-${index}`,
  message: index === 0 ? originalText : `needle ordinary memory ${index}.`,
  eventTime: "2020-01-01T00:00:00.000Z", vector: [1, 0, 0] }));
const preferred = Array.from({ length: 16 }, (_, index) => ({ id: `preferred-${index}`,
  message: `needle dated event ${index}. ${"noise ".repeat(100)}`,
  eventTime: "2020-01-02T00:00:00.000Z", vector: [-1, 0, 0] }));
const sources = [...originals, ...preferred].map(source => ({ ...source, text: `user: ${source.message}\n` }));
const time = { interpretation_clock: CLOCK, intervals: [{ start: "2020-01-02", end: "2020-01-02" }] };
const proposal = { schema_version: 1, producer_id: SOURCE_TEMPLATE_PROPOSAL_PRODUCER_ID,
  original_query_digest: digest("needle"), question_time: time,
  source_template: { interpretation_clock: CLOCK, asked_speaker: "user", evidence_statements: ["I finally beat <game> last weekend."] } };

it("restores a current statement-bound source through real SQLite, built Worker and MCP while freezing continuation membership", async () => {
  await withIndexedSources(sources, async fixture => {
    const client = await fixture.openClient(), service = new RecallService({ ...createDependencies().dependencies,
      now: () => CLOCK, readSnapshot: client.readSnapshot, conditionalFieldPort: client.conditionalFieldPort,
      activeConstraintsPort: client.activeConstraintsPort });
    const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, recallService: service });
    const call = async (extra: object) => {
      const output = await handler.call({ toolName: "soul.recall", arguments: { ...capableRecallConsumerDeclaration(),
        query: "needle", max_results: 5, scope_class: "project", dimension: null, domain_tags: null,
        result_kind_view: "source_only", ...extra }, context: { workspaceId: WS, runId: "run-1",
        sessionId: "source-template-session", agentTarget: "codex" } });
      if (!output.ok) throw new Error(JSON.stringify(output.error));
      return SoulMemorySearchResponseSchema.parse(output.output);
    };
    const wanted = fixture.targets.find(target => target.source_id === "original-0")!.target.root_id;
    const baseline = await call({ interpretation_proposal: { schema_version: 1,
      producer_id: QUESTION_TIME_PROPOSAL_PRODUCER_ID, original_query_digest: digest("needle"), question_time: time } });
    expect(baseline.index!.entries.every(entry => entry.target.kind === "source_evidence" && entry.target.root_id !== wanted)).toBe(true);
    const first = await call({ interpretation_proposal: proposal });
    expect(first.index!.result_version).toBe("ordinary-native-field.v13");
    expect(first.index!.entries[0]!.target).toMatchObject({ root_kind: "source_record", root_id: wanted });
    expect(first.index!.continuation).not.toBeNull();
    const oldVersion = await call({ interpretation_proposal: proposal, continuation: {
      ...first.index!.continuation!, result_version: "ordinary-native-field.v9"
    } });
    expect(oldVersion.index).toMatchObject({ entries: [], continuation: null,
      completeness: { logical_index: "invalidated", observed_coverage: "invalidated" } });
    const entries = [...first.index!.entries], prepared = fixture.prepareQuery.mock.calls.length;
    let continuation = first.index!.continuation;
    for (let page = 0; continuation !== null && page < 8; page++) {
      const args = { interpretation_proposal: proposal, continuation }, next = await call(args), replay = await call(args);
      expect(replay.results).toEqual(next.results);
      entries.push(...next.index!.entries); continuation = next.index!.continuation;
    }
    expect(continuation).toBeNull();
    expect(entries).toHaveLength(16);
    expect(new Set(entries.map(entry => entry.target.kind === "source_evidence" ? entry.target.root_id : "memory")).size).toBe(16);
    expect(fixture.prepareQuery.mock.calls).toHaveLength(prepared);
    const absentLiteral = await call({ interpretation_proposal: { ...proposal, source_template: {
      ...proposal.source_template, evidence_statements: ["I finally beat <game> cocktail last weekend."] } } });
    expect(absentLiteral.index!.entries.map(entry => [entry.target, entry.navigation]))
      .toEqual(baseline.index!.entries.map(entry => [entry.target, entry.navigation]));
    const guarded = { since: "2020-01-02T00:00:00.000Z" };
    const guardedTemplate = await call({ ...guarded, interpretation_proposal: proposal });
    const guardedBaseline = await call({ ...guarded, interpretation_proposal: { schema_version: 1,
      producer_id: QUESTION_TIME_PROPOSAL_PRODUCER_ID, original_query_digest: digest("needle"), question_time: time } });
    expect(guardedTemplate.index!.entries.map(entry => [entry.target, entry.navigation]))
      .toEqual(guardedBaseline.index!.entries.map(entry => [entry.target, entry.navigation]));
    const denied = await call({ scope_class: "global_core", interpretation_proposal: proposal });
    expect(denied.index?.entries ?? []).toEqual([]);
  }, { ...SIMULATED_CONFIGURATION, profile: { ...SIMULATED_CONFIGURATION.profile, max_input_tokens: 4096 } }, async directory => {
    const environment = storageFixture(join(directory, "alaya.db"));
    try {
      for (const source of sources) {
        const published = publishMessages(environment, [{ role: "user", text: source.message }], source.id, WS,
          source.eventTime, "project");
        if (source.id === "original-0") publishStatement(environment, published, "game-statement");
      }
    } finally { environment.database.close({ optimize: false }); }
  });
}, 30_000);
