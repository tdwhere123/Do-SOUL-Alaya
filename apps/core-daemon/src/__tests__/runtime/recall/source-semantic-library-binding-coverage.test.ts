import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { proofForLibraryEntry, selectSourceSemanticLibraryPage, sourceGoldRootIdentity } from "@do-soul/alaya-core";
import { closeCachedDatabase, openReadOnlyDatabase } from "@do-soul/alaya-storage";
import { selectSourceSemanticLibraryPageWithReturnedTupleNovelty } from
  "../../../../../../packages/core/src/recall/runtime/source-semantic-library-selection.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { createRecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { deliverResearchFixedSourceLibrary, runSourceSemanticLibraryRecall } from
  "../../../runtime/recall-read-worker/source-semantic-library-recall.js";
import { ACCESS_BUDGET, CLOCK, WS, accessCall, withAccessLibrary } from "./source-semantic-access.test-support.js";
import {
  EXISTING_TEST_WORK_UNITS, FIXTURE_NOTES, OUTPUT_BYTE_LIMITS, PAYLOAD_TOKENS, REQUIRED_LABELS,
  UNKNOWN_UTTERANCE_ATTRIBUTION, bodyLabelFromSource, encodedPage, encodedRecall, encodeBytes, fixtureSources, indexEntryCacheKey,
  namedLimitFits, pageLabels, pageRoots, proofTools, publishedInterpretation, queryOf, recallRequest,
  researchFixedInputs, sqliteSources, type Recall
} from "./source-semantic-library-binding-coverage.js";

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
  persisted: readonly { record_id: string; source_version?: string; source_body: string | null; content_digest: string }[],
  recall: Recall,
  rows: ReturnType<typeof publicRows>,
  encoded: ReturnType<typeof encodedPage>
) {
  expect(rows).toHaveLength(recall.index.entries.length);
  expect(recall.slot_qualifiers).toHaveLength(recall.index.entries.length);
  expect(encoded.results).toHaveLength(recall.index.entries.length);
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
    if (entry.target.kind === "source_evidence") {
      expect(entry.target.content_digest).toBe(stored!.content_digest);
      if (stored!.source_version !== undefined) expect(entry.target.source_version).toBe(stored!.source_version);
    }
    const proof = proofForLibraryEntry(entry, recall.proofs ?? []);
    expect(proof).toBeDefined();
    expect(proofTools(proof)).toEqual([bodyLabelFromSource(stored!.source_body)]);
    expect(row.proof_use).toBeDefined();
    expect(encoded.results![index]!.selection_reason).toMatch(/unknown/i);
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

function researchPayload(ids: ReadonlyMap<string, readonly string[]>, outputByteLimit: number = OUTPUT_BYTE_LIMITS.schema_max) {
  return {
    workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named" as const, scopes: ["project"] },
    request: recallRequest(ids, ACCESS_BUDGET.work_units, outputByteLimit)
  };
}

function deliverResearch(filename: string, ids: ReadonlyMap<string, readonly string[]>,
  rawRows: Parameters<typeof deliverResearchFixedSourceLibrary>[2],
  descriptors: Parameters<typeof deliverResearchFixedSourceLibrary>[3],
  selectPage?: Parameters<typeof deliverResearchFixedSourceLibrary>[4],
  outputByteLimit: number = OUTPUT_BYTE_LIMITS.schema_max) {
  const database = openReadOnlyDatabase(filename);
  try {
    return deliverResearchFixedSourceLibrary(database, researchPayload(ids, outputByteLimit), rawRows, descriptors, selectPage);
  } finally {
    database.close();
    closeCachedDatabase(filename);
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

it("research fixed-pool entry delivers default three names and novelty five without module substitution", async () => {
  await withAccessLibrary(fixtureSources(), async ({ execute, filename, ids }) => {
    const persisted = await sqliteSources(filename);
    expect(persisted).toHaveLength(10);
    const pool = await researchFixedInputs(filename, ids);
    expect(pool.rawRows).toHaveLength(10);
    expect(new Set(pool.rawRows.map((row) => row.record_id)).size).toBe(10);
    expect(pool.rawRows.every((row) => row.complete && row.body_bytes !== null && row.read_bytes === row.body_bytes)).toBe(true);
    expect(pool.descriptors).toHaveLength(10);
    const worker = await accessCall(execute, recallRequest(ids));
    expect(worker.kind).toBe("recall");
    expect(worker.request_budget).toEqual(ACCESS_BUDGET);
    const before = persisted.map((row) => ({
      source_id: row.source_id, record_id: row.record_id, source_version: row.source_version,
      content_digest: row.content_digest, source_body: row.source_body
    }));
    const omitted = deliverResearch(filename, ids, pool.rawRows, pool.descriptors);
    const injected = deliverResearch(filename, ids, pool.rawRows, pool.descriptors, selectSourceSemanticLibraryPage);
    const omittedEncoded = encodedRecall(omitted.encoded);
    const injectedEncoded = encodedRecall(injected.encoded);
    expect(omitted.provenance).toBe("research_fixed_pool");
    expect(injected.provenance).toBe("research_fixed_pool");
    expect(omitted.result.request_budget).toEqual(ACCESS_BUDGET);
    expect(injected.result.request_budget).toEqual(omitted.result.request_budget);
    expect(omitted.result.request_budget).toEqual(worker.request_budget);
    expect(pageIdentity(injected.result)).toEqual(pageIdentity(omitted.result));
    expect(injectedEncoded.results).toEqual(omittedEncoded.results);
    expect(injected.result.request_identity).toEqual(omitted.result.request_identity);
    expect(injected.result.delivery_id).toEqual(omitted.result.delivery_id);
    expect(queryOf().gaps).toEqual([]);
    expect(queryOf().attribution_context).toEqual(UNKNOWN_UTTERANCE_ATTRIBUTION);
    const defaultRows = publicRows(omitted.result);
    assertOriginals(persisted, omitted.result, defaultRows, omittedEncoded);
    const defaultLabels = assertCrowdedOmission(persisted, omitted.result, defaultRows);
    expect(pageLabels(omitted.result)).toEqual(pageLabels(worker));
    expect(encodeBytes(omittedEncoded)).toBeLessThanOrEqual(OUTPUT_BYTE_LIMITS.schema_max);
    expect((omittedEncoded.results ?? []).every((row) => row.budget_state.within_budget)).toBe(true);
    const candidate = deliverResearch(filename, ids, pool.rawRows, pool.descriptors,
      selectSourceSemanticLibraryPageWithReturnedTupleNovelty);
    const candidateEncoded = encodedRecall(candidate.encoded);
    expect(candidate.provenance).toBe("research_fixed_pool");
    expect(candidate.result.request_budget).toEqual(ACCESS_BUDGET);
    expect(encodeBytes(candidateEncoded)).toBeLessThanOrEqual(OUTPUT_BYTE_LIMITS.schema_max);
    expect((candidateEncoded.results ?? []).every((row) => row.budget_state.within_budget)).toBe(true);
    expect(pageLabels(candidate.result)).toEqual([...REQUIRED_LABELS].sort());
    const candidateRows = publicRows(candidate.result);
    expect(candidateRows).toHaveLength(5);
    assertOriginals(persisted, candidate.result, candidateRows, candidateEncoded);
    expect(new Set(pageRoots(candidate.result)).size).toBe(5);
    const bodyLabels = bodyLabelsForRows(persisted, candidateRows);
    expect([...new Set(bodyLabels)].sort()).toEqual([...REQUIRED_LABELS].sort());
    expect(bodyLabels).toHaveLength(5);
    for (const label of REQUIRED_LABELS) expect(bodyLabels.filter((item) => item === label)).toHaveLength(1);
    const limited = deliverResearch(filename, ids, pool.rawRows, pool.descriptors,
      selectSourceSemanticLibraryPageWithReturnedTupleNovelty, 200_000);
    const limitedEncoded = encodedRecall(limited.encoded);
    assertOriginals(persisted, limited.result, publicRows(limited.result), limitedEncoded);
    expect(limited.result.index.entries.length).toBeGreaterThan(0);
    expect(limited.result.index.entries.length).toBeLessThan(5);
    expect(limited.result.index.continuation).not.toBeNull();
    expect(encodeBytes(limitedEncoded)).toBeLessThanOrEqual(200_000);
    expect((limitedEncoded.results ?? []).every(row => row.budget_state.within_budget)).toBe(true);
    expect(() => deliverResearch(filename, ids, pool.rawRows, pool.descriptors, selectSourceSemanticLibraryPage,
      OUTPUT_BYTE_LIMITS.test_capped)).toThrow(/output budget cannot retain reserved source support/u);
    const continuation = omitted.result.index.continuation;
    expect(continuation).not.toBeNull();
    if (continuation === null) throw new Error("default page must carry a research continuation");
    {
      const ordinary = openReadOnlyDatabase(filename);
      try {
        expect(() => runSourceSemanticLibraryRecall(
          createRecallReadWorkerRuntime(ordinary),
          { workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] },
            request: { ...recallRequest(ids), continuation } },
          ["project"],
          new SourceSemanticReadBudget(ACCESS_BUDGET)
        )).toThrow(/expired|handle|continuation/i);
      } finally {
        ordinary.close();
        closeCachedDatabase(filename);
      }
    }
    expect(() => deliverResearch(filename, ids, pool.rawRows.slice(0, 6), pool.descriptors))
      .toThrow(/research window requires ten fully read distinct raw roots/);
    const after = await sqliteSources(filename);
    expect(after).toEqual(before);
    await writeReceipt("candidate.json", {
      arm: "research_fixed_pool_novelty", claim: "not compiled worker",
      same_fixture_default_matches_compiled_worker_labels: pageLabels(omitted.result).join(",") === pageLabels(worker).join(","),
      labels: pageLabels(candidate.result), body_labels: bodyLabels, default_labels: defaultLabels,
      distinct_roots: new Set(pageRoots(candidate.result)).size, encode_bytes: encodeBytes(candidateEncoded),
      payload_tokens: PAYLOAD_TOKENS, within_budget: (candidateEncoded.results ?? []).map((row) => row.budget_state.within_budget),
      rows: candidateRows, work: candidate.result.work
    });
  });
}, 180000);
