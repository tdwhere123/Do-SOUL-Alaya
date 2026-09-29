import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { encodeSourceSemanticLibraryResponse, proofForLibraryEntry, sourceGoldRootIdentity } from "@do-soul/alaya-core";
import { closeCachedDatabase, openReadOnlyDatabase } from "@do-soul/alaya-storage";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { createRecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { runSourceSemanticLibraryRecall } from "../../../runtime/recall-read-worker/source-semantic-library-recall.js";
import { ACCESS_BUDGET, CLOCK, WS, accessCall, withAccessLibrary } from "./source-semantic-access.test-support.js";
import {
  EXISTING_TEST_WORK_UNITS, FIXTURE_NOTES, OUTPUT_BYTE_LIMITS, PAYLOAD_TOKENS, REQUIRED_LABELS, bodyLabelFromSource,
  encodedPage, encodeBytes, fixtureSources, indexEntryCacheKey, namedLimitFits, pageLabels, pageRoots,
  proofTools, publishedInterpretation, recallRequest, sqliteSources, type Recall
} from "./source-semantic-library-binding-coverage.js";

const selectorState = vi.hoisted(() => ({ useNovelty: false }));

vi.mock("@do-soul/alaya-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@do-soul/alaya-core")>();
  const selection = await import("../../../../../../packages/core/src/recall/runtime/source-semantic-library-selection.js");
  return {
    ...actual,
    selectSourceSemanticLibraryPage: (input: Parameters<typeof actual.selectSourceSemanticLibraryPage>[0]) =>
      selectorState.useNovelty
        ? selection.selectSourceSemanticLibraryPageWithReturnedTupleNovelty(input)
        : actual.selectSourceSemanticLibraryPage(input)
  };
});

beforeEach(() => {
  selectorState.useNovelty = false;
});

async function writeReceipt(name: string, body: unknown) {
  const path = process.env.BINDING_COVERAGE_RECEIPT;
  if (path === undefined || path.length === 0) return;
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), `${JSON.stringify(body, null, 2)}\n`);
}

function pageIdentity(recall: Recall) {
  const encoded = encodedPage(recall);
  return {
    roots: pageRoots(recall),
    previews: recall.index.entries.map((entry) => recall.previews?.[indexEntryCacheKey(entry)] ?? null),
    proofs: (recall.proofs ?? []).map((proof) => ({
      source_interpretation_id: proof.source_interpretation_id,
      query_semantics_id: proof.query_semantics_id,
      semantic_correspondence_id: proof.semantic_correspondence_id,
      conditional_computation_id: proof.conditional_computation_id,
      mentions: proof.interpretation.mentions.map((mention) => ({
        id: mention.id, text: mention.text, assertion_id: mention.assertion_id, source_ref: mention.source_ref
      })),
      referents: proof.interpretation.referents,
      binding_results: (proof.binding_results ?? []).map((binding) => ({
        binding_id: binding.binding_id, returned: binding.returned, bindings: binding.bindings,
        explanation_ids: binding.explanation_ids, query_complete: binding.query_complete
      }))
    })),
    slot_qualifiers: recall.slot_qualifiers,
    source_disclosures: recall.source_disclosures,
    public_disclosures: (encoded.results ?? []).map((row) => row.source_disclosure)
  };
}

function publicRows(recall: Recall) {
  const encoded = encodedPage(recall);
  return (encoded.results ?? []).map((row, index) => {
    const entry = recall.index.entries[index]!;
    const qualifier = recall.slot_qualifiers[index];
    return {
      index, cache_key: indexEntryCacheKey(entry), qualifier_index: qualifier?.index,
      evidence_kind: qualifier?.evidence_kind,
      selection_basis: qualifier?.selection_basis, payload_support: qualifier?.payload_support,
      source_interpretation_id: qualifier?.source_interpretation_id,
      query_semantics_id: qualifier?.query_semantics_id,
      semantic_correspondence_id: qualifier?.semantic_correspondence_id,
      conditional_computation_id: qualifier?.conditional_computation_id,
      preview: recall.previews?.[indexEntryCacheKey(entry)], public_preview: row.content_preview,
      within_budget: row.budget_state.within_budget, max_total_tokens: row.budget_state.max_total_tokens,
      root_id: entry.target.kind === "source_evidence" ? entry.target.root_id : null,
      root: entry.target.kind === "source_evidence" ? sourceGoldRootIdentity(entry.target) : null,
      proof_use: row.source_disclosure?.proof_use, source_disclosure: row.source_disclosure
    };
  });
}

function bodyLabelsForRows(
  persisted: readonly { record_id: string; source_body: string | null }[],
  rows: ReturnType<typeof publicRows>
): string[] {
  return rows.map((row) => {
    const stored = persisted.find((item) => item.record_id === row.root_id);
    expect(stored).toBeDefined();
    return bodyLabelFromSource(stored!.source_body);
  });
}

function assertOriginals(
  persisted: readonly { record_id: string; source_body: string | null }[],
  recall: Recall,
  rows: ReturnType<typeof publicRows>,
  encoded: ReturnType<typeof encodedPage>
) {
  expect(rows).toHaveLength(recall.index.entries.length);
  expect(recall.slot_qualifiers).toHaveLength(recall.index.entries.length);
  for (const [index, row] of rows.entries()) {
    const entry = recall.index.entries[index]!;
    const qualifier = recall.slot_qualifiers[index];
    expect(qualifier).toBeDefined();
    expect(row.qualifier_index).toBe(index);
    expect(qualifier!.index).toBe(index);
    expect(row.cache_key).toBe(indexEntryCacheKey(encoded.index!.entries[index]!));
    expect(qualifier!.selection_basis).toEqual(expect.any(String));
    expect(qualifier!.payload_support).toEqual(expect.any(String));
    expect(row.selection_basis).toBe(qualifier!.selection_basis);
    expect(row.payload_support).toBe(qualifier!.payload_support);
    expect(row.max_total_tokens).toBe(PAYLOAD_TOKENS);
    const stored = persisted.find((item) => item.record_id === row.root_id);
    expect(stored).toBeDefined();
    expect(typeof stored!.source_body).toBe("string");
    expect(stored!.source_body!.length).toBeGreaterThan(0);
    expect(row.preview).toBe(stored!.source_body);
    expect(row.public_preview).toBe(stored!.source_body);
    expect(row.preview).toBe(row.public_preview);
    const proof = proofForLibraryEntry(entry, recall.proofs ?? []);
    expect(proof).toBeDefined();
    expect(proofTools(proof)).toEqual([bodyLabelFromSource(stored!.source_body)]);
  }
}

function assertCrowdedOmission(
  persisted: readonly { record_id: string; source_body: string | null }[],
  recall: Recall,
  rows: ReturnType<typeof publicRows>
) {
  expect(new Set(pageRoots(recall)).size).toBe(5);
  const labels = bodyLabelsForRows(persisted, rows);
  expect([...new Set(labels)].sort()).toEqual(["Kindle", "charger", "earbuds"]);
  expect(labels.filter((label) => label === "earbuds")).toHaveLength(2);
  expect(labels.filter((label) => label === "charger")).toHaveLength(2);
  expect(labels.filter((label) => label === "Kindle")).toHaveLength(1);
  expect(labels).not.toContain("Pixel");
  expect(labels).not.toContain("ThinkPad");
  expect(pageLabels(recall)).toEqual(["Kindle", "charger", "earbuds"]);
  return labels;
}

function inProcessRecall(filename: string, ids: ReadonlyMap<string, readonly string[]>) {
  const database = openReadOnlyDatabase(filename);
  const meter = new SourceSemanticReadBudget(ACCESS_BUDGET);
  try {
    const recalled = runSourceSemanticLibraryRecall(
      createRecallReadWorkerRuntime(database),
      { workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] },
        request: recallRequest(ids) },
      ["project"],
      meter
    );
    if (recalled.kind !== "recall") throw new Error("in-process recall expected");
    return { recalled, meter, database };
  } catch (error) {
    database.close();
    closeCachedDatabase(filename);
    throw error;
  }
}

it("compiled worker baseline omits Pixel and ThinkPad on the ten-source fixture", async () => {
  await withAccessLibrary(fixtureSources(), async ({ execute, filename, ids }) => {
    const persisted = await sqliteSources(filename);
    expect(persisted).toHaveLength(FIXTURE_NOTES.length);
    expect(new Set(persisted.map((row) => row.content_digest)).size).toBe(REQUIRED_LABELS.length);
    for (const digest of new Set(persisted.map((row) => row.content_digest))) {
      const group = persisted.filter((row) => row.content_digest === digest);
      expect(new Set(group.map((row) => row.source_id)).size).toBe(2);
      expect(new Set(group.map((row) => row.record_id)).size).toBe(2);
    }
    for (const note of FIXTURE_NOTES) {
      const prepared = await accessCall(execute, { kind: "prepare_source", source_id: note.id, budget: ACCESS_BUDGET });
      const catalogIds = new Set(prepared.catalog.assertions.flatMap((row) => row.segments.map((part) => part.id)));
      const published = await publishedInterpretation(filename, ids.get(note.id)![0]!);
      expect(published.interpretation.mentions.length).toBeGreaterThan(0);
      for (const mention of published.interpretation.mentions) {
        expect(catalogIds.has(mention.source_ref.first)).toBe(true);
        expect(catalogIds.has(mention.source_ref.last)).toBe(true);
      }
    }
    const worker = await accessCall(execute, recallRequest(ids));
    expect(worker.kind).toBe("recall");
    const encoded = encodedPage(worker);
    const bytes = encodeBytes(encoded);
    expect(bytes).toBeLessThanOrEqual(OUTPUT_BYTE_LIMITS.schema_max);
    const rows = publicRows(worker);
    assertOriginals(persisted, worker, rows, encoded);
    const labels = assertCrowdedOmission(persisted, worker, rows);
    const limited = await accessCall(execute, recallRequest(ids, EXISTING_TEST_WORK_UNITS));
    expect(limited.coverage.payload === "truncated" || limited.discovery.truncated === true).toBe(true);
    await writeReceipt("baseline.json", {
      arm: "compiled_worker", labels, body_labels: labels, missing: ["Pixel", "ThinkPad"],
      distinct_roots: new Set(pageRoots(worker)).size, encode_bytes: bytes, payload_tokens: PAYLOAD_TOKENS,
      named_limit_fit_arithmetic_not_native_rerun: namedLimitFits(bytes), rows,
      existing_test_work_units: EXISTING_TEST_WORK_UNITS, existing_test_work_truncated: true,
      existing_test_work_coverage: limited.coverage, work: worker.work
    });
  });
}, 120000);

it("in-process novelty selector delivers all five names through the library delivery owner", async () => {
  await withAccessLibrary(fixtureSources(), async ({ execute, filename, ids }) => {
    const persisted = await sqliteSources(filename);
    const worker = await accessCall(execute, recallRequest(ids));
    expect(worker.kind).toBe("recall");
    const workerRows = publicRows(worker);
    assertOriginals(persisted, worker, workerRows, encodedPage(worker));
    assertCrowdedOmission(persisted, worker, workerRows);
    selectorState.useNovelty = false;
    const inDefault = inProcessRecall(filename, ids);
    try {
      expect(pageIdentity(inDefault.recalled)).toEqual(pageIdentity(worker));
      const defaultRows = publicRows(inDefault.recalled);
      assertOriginals(persisted, inDefault.recalled, defaultRows, encodedPage(inDefault.recalled));
      assertCrowdedOmission(persisted, inDefault.recalled, defaultRows);
      selectorState.useNovelty = true;
      const candidate = inProcessRecall(filename, ids);
      try {
        const encoded = encodeSourceSemanticLibraryResponse(candidate.recalled);
        if (encoded.operation !== "recall") throw new Error("encoded recall expected");
        const bytes = encodeBytes(encoded);
        expect(bytes).toBeLessThanOrEqual(OUTPUT_BYTE_LIMITS.schema_max);
        expect((encoded.results ?? []).every((row) => row.budget_state.within_budget)).toBe(true);
        expect(pageLabels(candidate.recalled)).toEqual([...REQUIRED_LABELS].sort());
        const rows = publicRows(candidate.recalled);
        expect(rows).toHaveLength(5);
        assertOriginals(persisted, candidate.recalled, rows, encoded);
        expect(new Set(pageRoots(candidate.recalled)).size).toBe(5);
        const bodyLabels = bodyLabelsForRows(persisted, rows);
        expect([...new Set(bodyLabels)].sort()).toEqual([...REQUIRED_LABELS].sort());
        expect(bodyLabels).toHaveLength(5);
        for (const label of REQUIRED_LABELS) expect(bodyLabels.filter((item) => item === label)).toHaveLength(1);
        await writeReceipt("candidate.json", {
          arm: "in_process_novelty_mock", claim: "not compiled worker",
          same_fixture_default_matches_compiled_worker: true,
          labels: pageLabels(candidate.recalled), body_labels: bodyLabels,
          distinct_roots: new Set(pageRoots(candidate.recalled)).size, encode_bytes: bytes,
          payload_tokens: PAYLOAD_TOKENS,
          named_limit_fit_arithmetic_not_native_rerun: namedLimitFits(bytes),
          within_budget: (encoded.results ?? []).map((row) => row.budget_state.within_budget),
          rows, observed_meter_this_run_not_final: {
            spentWork: candidate.meter.spentWork, spentBytes: candidate.meter.spentBytes
          }, work: candidate.recalled.work
        });
      } finally {
        candidate.database.close();
        closeCachedDatabase(filename);
      }
    } finally {
      inDefault.database.close();
      closeCachedDatabase(filename);
    }
  });
}, 120000);
