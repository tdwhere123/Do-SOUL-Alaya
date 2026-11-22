import { describe, expect, it } from "vitest";
import { canonicalIndexEntryIdentity, indexEntryCacheKey } from "@do-soul/alaya-protocol";
import type { ConditionalFieldRecallPortResult } from "@do-soul/alaya-core";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import {
  createQueryOnlyHydrationHarness,
  dispatchQueryOnly,
  conditionalRecallPayload,
  createQueryOnlyRuntime,
  persistConditionalSource
} from "./query-only-hydration-fixture.js";

const hydration = createQueryOnlyHydrationHarness();

describe("query-only field hydration equivalence", () => {
  it("preserves actual source-backed index through query-only worker dispatch", async () => {
    const fixture = await hydration.openHydrationFixture();
    const objectId = "88888888-8888-4888-8888-888888888888";
    const { source } = await persistConditionalSource(fixture.writer, objectId, "nebulapivot published source");
    const payload = conditionalRecallPayload("nebulapivot");
    const direct = await dispatchQueryOnly(createQueryOnlyRuntime(fixture.writer),
      "conditionalField.recall", payload) as ConditionalFieldRecallPortResult;
    const dispatched = await dispatchQueryOnly(fixture.queryOnlyRuntime,
      "conditionalField.recall", payload) as ConditionalFieldRecallPortResult;
    expect(dispatched.index.continuation).not.toBeNull();
    expect(direct.index.continuation).not.toBeNull();
    expect(dispatched.index).toEqual({ ...direct.index, continuation: {
      ...direct.index.continuation,
      continuation_id: dispatched.index.continuation!.continuation_id,
      capability: dispatched.index.continuation!.capability
    } });
    expect(dispatched.previews).toEqual(direct.previews);
    expect(dispatched.index.entries.map((entry) => entry.target.kind)).toEqual([
      "source_evidence",
      "memory_entry"
    ]);
    expect(dispatched.index.entries.find((entry) => entry.target.kind === "memory_entry")?.object_id)
      .toBe(objectId);
    expect(dispatched.previews[objectId]).toContain("nebulapivot");
    const delivered = dispatched.index.entries.find((entry) => entry.target.kind === "source_evidence")!;
    expect(delivered).toMatchObject({ target: {
      root_kind: "source_record", root_id: source.identity, source_version: "1",
      content_digest: source.content_digest, evidence_object_id: null,
      span: { content_start: 0, content_complete: true }
    }, navigation: { operator: "source_lexical", view: "original" } });
    expect(delivered.object_id).toBeUndefined();
    expect(dispatched.previews[indexEntryCacheKey(delivered)]).toBe("nebulapivot published source");
    expect(fixture.queryOnly.connection.pragma("query_only", { simple: true })).toBe(1);
  });

  it("matches native worker product identities with direct query-only dispatch", async () => {
    const fixture = await hydration.openHydrationFixture();
    const objectId = "88888888-8888-4888-8888-888888888888";
    const { source } = await persistConditionalSource(fixture.writer, objectId, "nebulapivot published source");
    const payload = conditionalRecallPayload("nebulapivot");
    const direct = await dispatchQueryOnly(createQueryOnlyRuntime(fixture.writer),
      "conditionalField.recall", payload) as ConditionalFieldRecallPortResult;
    const worker = createRecallReadWorkerClient({
      databaseFilename: fixture.writer.filename,
      workerCount: 1,
      workerUrl: new URL("../../../../dist/runtime/recall/recall-read-worker.js", import.meta.url)
    });
    if (worker === null) throw new Error("real worker required");
    try {
      await worker.ready();
      const recalled = await worker.conditionalFieldPort.recall(payload);
      const index = "index" in recalled ? recalled.index : recalled;
      expect(index.entries.map(canonicalIndexEntryIdentity))
        .toEqual(direct.index.entries.map(canonicalIndexEntryIdentity));
      expect(index.entries.map((entry) => entry.target.kind).sort())
        .toEqual(["memory_entry", "source_evidence"]);
      expect(index.entries.find((entry) => entry.target.kind === "memory_entry")?.object_id)
        .toBe(objectId);
      const delivered = index.entries.find((entry) => entry.target.kind === "source_evidence")!;
      expect(delivered.object_id).toBeUndefined();
      expect(delivered.target).toMatchObject({ root_kind: "source_record", root_id: source.identity,
        evidence_object_id: null, span: { content_start: 0, content_complete: true } });
      expect("previews" in recalled && recalled.previews[indexEntryCacheKey(delivered)])
        .toBe("nebulapivot published source");
    } finally {
      await worker.close();
    }
  });
});
