import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { sourceDisclosure } from "@do-soul/alaya-protocol";
import {
  proofForLibraryEntry, projectSourceSemanticQuerySupport, sourceGoldRootIdentity
} from "@do-soul/alaya-core";
import { ACCESS_BUDGET, accessCall, withAccessLibrary } from "./source-semantic-access.test-support.js";
import {
  CLASS_NOUN, CLASS_READING, EXISTING_TEST_WORK_UNITS, FIXTURE_NOTES, NON_TOOL_LABEL, ORIGINAL, OUTPUT_BYTE_LIMITS,
  PAYLOAD_TOKENS, REQUIRED_LABELS, UNKNOWN_UTTERANCE_ATTRIBUTION, aliceUsesDraft, bodyClassFromSource, bodyLabelFromSource,
  correspondenceOf, encodedPage, encodeBytes, fixtureSources, indexEntryCacheKey, isNonToolNote, namedLimitFits, pageLabels,
  pageRoots, proofClassTexts, proofTools, publishedInterpretation, queryOf, recallRequest,
  sentenceFor, sqliteSources, type Recall
} from "./source-semantic-library-binding-coverage.js";

const RECEIPT_DIRECTORY = process.env.BINDING_COVERAGE_RECEIPT && process.env.BINDING_COVERAGE_RECEIPT.length > 0
  ? (process.env.BINDING_COVERAGE_RECEIPT.endsWith(".json")
    ? dirname(process.env.BINDING_COVERAGE_RECEIPT) : process.env.BINDING_COVERAGE_RECEIPT)
  : undefined;

async function writeReceipt(name: string, body: unknown) {
  if (RECEIPT_DIRECTORY === undefined) return;
  await mkdir(RECEIPT_DIRECTORY, { recursive: true });
  const text = typeof body === "string" ? (body.endsWith("\n") ? body : `${body}\n`) : `${JSON.stringify(body, null, 2)}\n`;
  await writeFile(join(RECEIPT_DIRECTORY, name), text);
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
      proof_use: row.source_disclosure === undefined ? undefined : sourceDisclosure(row.source_disclosure).proof_use, source_disclosure: row.source_disclosure
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
    expect(queryOf().requested_operation).toEqual({ reading: "enumerate", support: { kind: "query_text", excerpt: ORIGINAL } });
    expect(queryOf().alternatives[0]!.answer_frames).toEqual([]);
    expect(queryOf().alternatives[0]!.evidence_inputs).toEqual([{ frames: ["qUse", "qKind"] }]);
    expect(queryOf().return_variables).toEqual([]);
    expect(queryOf().gaps).toEqual([{
      kind: "aggregate", affected_ids: ["tools"], support: [{ kind: "query_text", excerpt: "which tools" }],
      description: "Complete tool enumeration is not executed; class-qualified use remains a local witness."
    }]);
    expect(queryOf().attribution_context).toEqual(UNKNOWN_UTTERANCE_ATTRIBUTION);
    expect(queryOf().variables.find(row => row.id === "tools")?.reference).toBeUndefined();
    const worker = await accessCall(execute, recallRequest(ids));
    expect(worker.kind).toBe("recall");
    expect(worker.request_budget).toEqual(ACCESS_BUDGET);
    const encoded = encodedPage(worker);
    const bytes = encodeBytes(encoded);
    expect(bytes).toBeLessThanOrEqual(OUTPUT_BYTE_LIMITS.schema_max);
    const rows = publicRows(worker);
    assertOriginals(persisted, worker, rows, encoded);
    assertUnrepresentedEnumeration(worker);
    const labels = assertCrowdedOmission(persisted, worker, rows);
    const limited = await accessCall(execute, recallRequest(ids, EXISTING_TEST_WORK_UNITS));
    expect(limited.index.entries).toEqual([]);
    expect(limited.discovery.access?.trace).toMatchObject({ kind: "library_selection" });
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
