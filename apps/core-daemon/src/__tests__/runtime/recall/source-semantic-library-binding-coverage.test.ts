import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import {
  proofForLibraryEntry, projectSourceSemanticQuerySupport, selectSourceSemanticLibraryPage, sourceGoldRootIdentity
} from "@do-soul/alaya-core";
import { closeCachedDatabase, openReadOnlyDatabase } from "@do-soul/alaya-storage";
import { selectSourceSemanticLibraryPageWithReturnedTupleNovelty } from
  "../../../../../../packages/core/src/recall/runtime/source-semantic-library-selection.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { createRecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { deliverResearchFixedSourceLibrary, runSourceSemanticLibraryRecall } from
  "../../../runtime/recall-read-worker/source-semantic-library-recall.js";
import { ACCESS_BUDGET, CLOCK, WS, accessCall, withAccessLibrary } from "./source-semantic-access.test-support.js";
import {
  CLASS_NOUN, CLASS_READING, EXISTING_TEST_WORK_UNITS, FIXTURE_NOTES, NON_TOOL_LABEL, ORIGINAL, OUTPUT_BYTE_LIMITS,
  PAYLOAD_TOKENS, REQUIRED_LABELS, UNKNOWN_UTTERANCE_ATTRIBUTION, aliceUsesDraft, bodyClassFromSource, bodyLabelFromSource,
  encodedPage, encodedRecall, encodeBytes, fixtureSources, indexEntryCacheKey, isNonToolNote, namedLimitFits, pageLabels,
  pageRoots, proofClassTexts, proofTools, publishedInterpretation, queryOf, recallRequest,
  researchFixedInputs, sentenceFor, sqliteSources, type Recall
} from "./source-semantic-library-binding-coverage.js";

const RECEIPT_DIRECTORY = process.env.BINDING_COVERAGE_RECEIPT && process.env.BINDING_COVERAGE_RECEIPT.length > 0
  ? (process.env.BINDING_COVERAGE_RECEIPT.endsWith(".json")
    ? dirname(process.env.BINDING_COVERAGE_RECEIPT) : process.env.BINDING_COVERAGE_RECEIPT)
  : "/home/tdwhere/vibe/Do-SOUL-Alaya/.do-it/bench-runs/semantic-recall-20260929/qhc-responsibility-boundary/native-qualified-delivery";

async function writeReceipt(name: string, body: unknown) {
  await mkdir(RECEIPT_DIRECTORY, { recursive: true });
  const text = typeof body === "string" ? (body.endsWith("\n") ? body : `${body}\n`) : `${JSON.stringify(body, null, 2)}\n`;
  await writeFile(join(RECEIPT_DIRECTORY, name), text);
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
    const object = bodyLabelFromSource(stored!.source_body);
    const classified = bodyClassFromSource(stored!.source_body);
    expect(proofTools(proof)).toEqual([object]);
    expect(proofClassTexts(proof)).toEqual(classified === CLASS_NOUN ? [CLASS_NOUN] : []);
    expect(proofTools(proof)).not.toContain(NON_TOOL_LABEL);
    expect(proofClassTexts(proof)).not.toEqual(proofTools(proof));
    expect(object).not.toBe(CLASS_NOUN);
    if (classified === CLASS_NOUN) {
      expect(stored!.source_body).toContain(`, a ${CLASS_NOUN}.`);
      expect(stored!.source_body).toContain(object);
    }
    expect(row.proof_use).toBeDefined();
    expect(encoded.results![index]!.selection_reason).toMatch(/unknown/i);
  }
  expect(pageLabels(recall)).not.toContain(NON_TOOL_LABEL);
}

function assertCrowdedOmission(
  persisted: readonly { record_id: string; source_body: string | null }[],
  recall: Recall,
  rows: ReturnType<typeof publicRows>
) {
  expect(new Set(pageRoots(recall)).size).toBe(5);
  const labels = bodyLabelsForRows(persisted, rows);
  const distinct = [...new Set(labels)].sort();
  expect(distinct).toEqual(["Kindle", "ThinkPad", "earbuds"]);
  expect(labels).toHaveLength(5);
  expect(distinct.map((label) => labels.filter((item) => item === label).length).sort()).toEqual([1, 2, 2]);
  expect(labels).not.toContain("Pixel");
  expect(labels).not.toContain("charger");
  expect(labels).not.toContain(NON_TOOL_LABEL);
  expect(pageLabels(recall)).toEqual(distinct);
  expect(pageLabels(recall)).not.toContain(NON_TOOL_LABEL);
  return labels;
}

function consumedPredicate(proof: NonNullable<Recall["proofs"]>[number], occurrence: "fUse" | "fKind"): boolean {
  return proof.consumed_leaves.some((row) => row.leaf_kind === "semantic_correspondence_predicate" && row.occurrence === occurrence);
}

function assertUnrepresentedEnumeration(recall: Recall, query = queryOf()) {
  const proofs = recall.proofs ?? [];
  expect(proofs.length).toBeGreaterThan(0);
  const bindings = proofs.flatMap((proof) => proof.binding_results ?? []);
  const support = projectSourceSemanticQuerySupport(query, bindings);
  expect(support.answer).toBe("unrepresented");
  expect(support.operation).toBe("not_executed");
  expect(support.evidence_inputs).toEqual([{ alternative: 0, input: 0, status: "supported" }]);
  expect(bindings.length).toBeGreaterThan(0);
  expect(bindings.every((row) => row.kind === "evidence" && row.input === 0 && row.query_complete === false)).toBe(true);
  for (const proof of proofs) {
    expect(consumedPredicate(proof, "fUse")).toBe(true);
    expect(consumedPredicate(proof, "fKind")).toBe(true);
  }
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

it("compiled worker baseline omits Pixel and charger on the ten-source fixture", async () => {
  await withAccessLibrary(fixtureSources(), async ({ execute, filename, ids }) => {
    const persisted = await sqliteSources(filename);
    expect(persisted).toHaveLength(FIXTURE_NOTES.length);
    const objects = persisted.map((row) => bodyLabelFromSource(row.source_body));
    expect(new Set(objects.filter((label) => label !== NON_TOOL_LABEL)).size).toBe(REQUIRED_LABELS.length);
    expect(objects.filter((label) => label === NON_TOOL_LABEL)).toHaveLength(1);
    expect(persisted.filter((row) => bodyClassFromSource(row.source_body) === CLASS_NOUN)).toHaveLength(9);
    for (const note of FIXTURE_NOTES) {
      const prepared = await accessCall(execute, { kind: "prepare_source", source_id: note.id, budget: ACCESS_BUDGET });
      const catalogIds = new Set(prepared.catalog.assertions.flatMap((row) => row.segments.map((part) => part.id)));
      const published = await publishedInterpretation(filename, ids.get(note.id)![0]!);
      expect(published.interpretation.mentions.length).toBeGreaterThan(0);
      for (const mention of published.interpretation.mentions) {
        expect(catalogIds.has(mention.source_ref.first)).toBe(true);
        expect(catalogIds.has(mention.source_ref.last)).toBe(true);
      }
      const classFrames = published.interpretation.frames.filter((frame) => frame.predicate_support.reading === CLASS_READING);
      if (isNonToolNote(note)) {
        expect(classFrames).toHaveLength(0);
        expect(published.interpretation.mentions.some((mention) => mention.text === CLASS_NOUN)).toBe(false);
        continue;
      }
      expect(classFrames).toHaveLength(1);
      expect(classFrames[0]!.predicate_support.kind).toBe("implicit");
      const useFrame = published.interpretation.frames.find((frame) => frame.predicate_support.reading === "use");
      const themeOf = (frame: NonNullable<typeof useFrame>) => {
        const slot = frame.slots.find((row) => row.role_reading === "theme");
        const binding = frame.bindings.find((row) => row.slot_id === slot?.id);
        return binding?.target.kind === "node" ? binding.target.id : undefined;
      };
      expect(themeOf(classFrames[0]!)).toBe(themeOf(useFrame!));
      expect(published.interpretation.mentions.some((mention) => mention.text === note.label)).toBe(true);
      expect(published.interpretation.mentions.some((mention) => mention.text === CLASS_NOUN)).toBe(true);
    }
    const worker = await accessCall(execute, recallRequest(ids));
    expect(worker.kind).toBe("recall");
    const encoded = encodedPage(worker);
    const bytes = encodeBytes(encoded);
    expect(bytes).toBeLessThanOrEqual(OUTPUT_BYTE_LIMITS.schema_max);
    const rows = publicRows(worker);
    assertOriginals(persisted, worker, rows, encoded);
    assertUnrepresentedEnumeration(worker);
    const labels = assertCrowdedOmission(persisted, worker, rows);
    const limited = await accessCall(execute, recallRequest(ids, EXISTING_TEST_WORK_UNITS));
    expect(limited.coverage.payload === "truncated" || limited.discovery.truncated === true).toBe(true);
    await writeReceipt("baseline.json", {
      arm: "compiled_worker", labels, body_labels: labels, missing: ["Pixel", "charger", NON_TOOL_LABEL],
      class_reading: CLASS_READING, non_tool_label: NON_TOOL_LABEL,
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
    expect(queryOf().requested_operation).toEqual({ reading: "enumerate", support: { kind: "query_text", excerpt: ORIGINAL } });
    expect(queryOf().alternatives[0]!.answer_frames).toEqual([]);
    expect(queryOf().alternatives[0]!.evidence_inputs).toEqual([{ frames: ["qUse", "qKind"] }]);
    expect(queryOf().return_variables).toEqual([]);
    expect(queryOf().gaps).toEqual([{
      kind: "aggregate", affected_ids: ["tools"],
      support: [{ kind: "query_text", excerpt: "which tools" }],
      description: "Complete tool enumeration is not executed; class-qualified use remains a local witness."
    }]);
    expect(queryOf().attribution_context).toEqual(UNKNOWN_UTTERANCE_ATTRIBUTION);
    expect(queryOf().alternatives[0]!.frames.some((frame) => frame.predicate_reading === CLASS_READING)).toBe(true);
    expect(queryOf().variables.find((row) => row.id === "tools")?.reference).toBeUndefined();
    const defaultRows = publicRows(omitted.result);
    assertOriginals(persisted, omitted.result, defaultRows, omittedEncoded);
    assertUnrepresentedEnumeration(omitted.result);
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
    expect(pageLabels(candidate.result)).not.toContain(NON_TOOL_LABEL);
    const candidateRows = publicRows(candidate.result);
    expect(candidateRows).toHaveLength(5);
    assertOriginals(persisted, candidate.result, candidateRows, candidateEncoded);
    assertUnrepresentedEnumeration(candidate.result);
    expect(new Set(pageRoots(candidate.result)).size).toBe(5);
    const bodyLabels = bodyLabelsForRows(persisted, candidateRows);
    expect([...new Set(bodyLabels)].sort()).toEqual([...REQUIRED_LABELS].sort());
    expect(bodyLabels).toHaveLength(5);
    expect(bodyLabels).not.toContain(NON_TOOL_LABEL);
    for (const label of REQUIRED_LABELS) expect(bodyLabels.filter((item) => item === label)).toHaveLength(1);
    const limited = deliverResearch(filename, ids, pool.rawRows, pool.descriptors,
      selectSourceSemanticLibraryPageWithReturnedTupleNovelty, 200_000);
    const limitedEncoded = encodedRecall(limited.encoded);
    const limitedRows = publicRows(limited.result);
    const limitedBytes = encodeBytes(limitedEncoded);
    expect(limited.result.index.entries.length).toBe(5);
    expect(limited.result.proofs ?? []).toHaveLength(2);
    expect(limited.result.index.continuation).not.toBeNull();
    expect(limitedBytes).toBeLessThanOrEqual(200_000);
    expect((limitedEncoded.results ?? []).every(row => row.budget_state.within_budget)).toBe(true);
    let limitedProved = 0;
    for (const [index, row] of limitedRows.entries()) {
      const stored = persisted.find((item) => item.record_id === row.root_id);
      expect(stored).toBeDefined();
      expect(row.preview).toBe(stored!.source_body);
      const proof = proofForLibraryEntry(limited.result.index.entries[index]!, limited.result.proofs ?? []);
      if (proof === undefined) continue;
      limitedProved += 1;
      expect(proofTools(proof)).toEqual([bodyLabelFromSource(stored!.source_body)]);
      expect(proofClassTexts(proof)).toEqual([CLASS_NOUN]);
      expect(proofTools(proof)).not.toContain(NON_TOOL_LABEL);
    }
    expect(limitedProved).toBe(2);
    assertUnrepresentedEnumeration(limited.result);
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
    const defaultBytes = encodeBytes(omittedEncoded);
    const candidateBytes = encodeBytes(candidateEncoded);
    await writeReceipt("candidate.json", {
      arm: "research_fixed_pool_novelty", claim: "not compiled worker",
      same_fixture_default_matches_compiled_worker_labels: pageLabels(omitted.result).join(",") === pageLabels(worker).join(","),
      labels: pageLabels(candidate.result), body_labels: bodyLabels, default_labels: defaultLabels,
      non_tool_label: NON_TOOL_LABEL, class_reading: CLASS_READING,
      distinct_roots: new Set(pageRoots(candidate.result)).size, encode_bytes: candidateBytes,
      default_encode_bytes: defaultBytes, payload_tokens: PAYLOAD_TOKENS,
      named_limit_fit_arithmetic_not_native_rerun: namedLimitFits(candidateBytes),
      default_named_limit_fit_arithmetic_not_native_rerun: namedLimitFits(defaultBytes),
      within_budget: (candidateEncoded.results ?? []).map((row) => row.budget_state.within_budget),
      rows: candidateRows, work: candidate.result.work, default_work: omitted.result.work,
      limited_200k_entries: limited.result.index.entries.length, limited_200k_encode_bytes: limitedBytes,
      limited_200k_proved: limitedProved, limited_200k_continuation: limited.result.index.continuation !== null,
      limited_200k_named_limit_fit: namedLimitFits(limitedBytes)
    });
    await writeReceipt("report.md", [
      "# Native qualified delivery",
      "",
      "Constructed semantic capacity on the ten-root native selector fixture. Not natural-language producer fidelity.",
      "Q does not represent a complete answer to which tools Alice uses. requested_operation enumerate stays not_executed; qUse and qKind are one evidence input; answer_frames are empty; tools remains an aggregate gap.",
      "H class premises are implicit lexical support on `tool`, attached to the same object as use.",
      "C maps the class predicate to that H frame and keeps original qUse/qKind endpoints; entity keys/excerpts are not class proof.",
      "One Pixel duplicate was replaced by a use-only coffee source. Ten-root research window is unchanged. Old cohort-budget metrics were not overwritten.",
      "",
      `- default labels: ${defaultLabels.join(", ")}`,
      `- novelty labels: ${pageLabels(candidate.result).join(", ")}`,
      `- default encode bytes: ${defaultBytes}`,
      `- novelty encode bytes: ${candidateBytes}`,
      `- default work: ${JSON.stringify(omitted.result.work)}`,
      `- novelty work: ${JSON.stringify(candidate.result.work)}`,
      `- named limit fit (novelty): ${JSON.stringify(namedLimitFits(candidateBytes))}`,
      `- 200k novelty entries/proved/bytes: ${limited.result.index.entries.length}/${limitedProved}/${limitedBytes}`,
      "- isolated coffee control: see measured result in class-controls.json",
      ""
    ].join("\n"));
  });
}, 180000);

it("omitted class, wrong-object class, non-tool use, and partial gap stay truthful", async () => {
  const pixel = {
    id: "note-pixel-desk", text: sentenceFor("Pixel"), verbatim: true as const,
    authoredDraft: (catalog: Parameters<typeof aliceUsesDraft>[0]) => aliceUsesDraft(catalog, "Pixel", "same_object")
  };
  const controls: Record<string, unknown> = {};
  await withAccessLibrary([pixel], async ({ execute, ids }) => {
    const full = await accessCall(execute, recallRequest(ids));
    expect(full.kind).toBe("recall");
    expect(pageLabels(full)).toEqual(["Pixel"]);
    const proof = full.proofs?.[0];
    expect(proofTools(proof)).toEqual(["Pixel"]);
    expect(proofClassTexts(proof)).toEqual([CLASS_NOUN]);
    expect(proofClassTexts(proof)).not.toEqual(proofTools(proof));
    assertUnrepresentedEnumeration(full);
    const omitted = await accessCall(execute, recallRequest(ids, ACCESS_BUDGET.work_units, OUTPUT_BYTE_LIMITS.schema_max, {
      classCorrespondence: "omitted"
    }));
    expect(pageLabels(omitted)).toEqual([]);
    expect(omitted.proofs ?? []).toEqual([]);
    const partialSupport = projectSourceSemanticQuerySupport(queryOf(), proof?.binding_results ?? []);
    controls.partial_gap_answer = partialSupport.answer;
    controls.partial_gap_consumed_predicates = proof?.consumed_leaves
      .filter(row => row.leaf_kind === "semantic_correspondence_predicate").map(row => row.occurrence) ?? [];
    controls.positive_labels = pageLabels(full);
    controls.omitted_labels = pageLabels(omitted);
    controls.partial_gap_labels = pageLabels(full);
    controls.partial_gap_query_complete = proof?.binding_results?.map((row) => row.query_complete) ?? [];
    controls.positive_class_leaf = proof !== undefined && consumedPredicate(proof, "fKind");
  });
  await withAccessLibrary([{
    id: "note-pixel-desk", text: sentenceFor("Pixel"), verbatim: true as const,
    authoredDraft: (catalog: Parameters<typeof aliceUsesDraft>[0]) => aliceUsesDraft(catalog, "Pixel", "other_object")
  }], async ({ execute, ids }) => {
    const recalled = await accessCall(execute, recallRequest(ids, ACCESS_BUDGET.work_units, OUTPUT_BYTE_LIMITS.schema_max, {
      classCorrespondence: "other_object"
    }));
    expect(pageLabels(recalled)).toEqual([]);
    expect(recalled.proofs ?? []).toEqual([]);
    controls.wrong_object_labels = pageLabels(recalled);
  });
  await withAccessLibrary([{
    id: "note-coffee-cup", text: sentenceFor(NON_TOOL_LABEL, "non_tool"), verbatim: true as const,
    authoredDraft: (catalog: Parameters<typeof aliceUsesDraft>[0]) => aliceUsesDraft(catalog, NON_TOOL_LABEL, "omitted")
  }], async ({ execute, ids }) => {
    const recalled = await accessCall(execute, recallRequest(ids));
    expect(pageLabels(recalled)).toEqual([]);
    expect((recalled.proofs ?? []).flatMap((proof) => proofTools(proof))).not.toContain(NON_TOOL_LABEL);
    const coffeeReceivedToolQualifiedProof = (recalled.proofs ?? []).some((proof) =>
      proofTools(proof).includes(NON_TOOL_LABEL) && proofClassTexts(proof).includes(CLASS_NOUN));
    expect(coffeeReceivedToolQualifiedProof).toBe(false);
    controls.non_tool_labels = pageLabels(recalled);
    controls.coffee_received_tool_qualified_proof = coffeeReceivedToolQualifiedProof;
  });
  await writeReceipt("class-controls.json", controls);
}, 180000);
