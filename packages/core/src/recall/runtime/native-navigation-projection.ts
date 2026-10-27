import { memoryRecallTarget, sourceGoldRootIdentity, hashContentDigest, SourceSemanticResourceLedger, SourceSemanticResourceExhausted,
  type FieldValue, type RecallNavigationWitness, type RecallTargetRef } from "@do-soul/alaya-protocol";
import { sourceFactKey } from "../conditional-field/engine/binding-environment.js";
import type { FieldEngineState } from "../conditional-field/engine/field-engine.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { orderNativeFieldAccess, type NativeRouteLane, type NativeRouteOccurrence } from "./native-route-opportunity.js";
import { compareFieldValues } from "./index-continuation.js";
import { CoreError } from "../../shared/errors.js";

/** Field membership is observed before access ordering. The native opportunity
 * owner sees the complete captured occurrences, including duplicate source hits,
 * and the observed memory-FTS lane. No separately selected pages are concatenated.
 *
 * The returned status keeps three distinct facts apart: a total navigation order,
 * a non-total order where a bound root lacks its captured catalog position, and a
 * refused ordering because the resource ledger was exhausted. A non-total order is
 * navigation incompleteness, not a retryable resource interruption.
 */
export type NativeFieldNavigation =
  | Readonly<{ status: "ordered"; witnessFor: (target: RecallTargetRef) => RecallNavigationWitness | undefined;
    values: Readonly<{ size: number; at: (index: number) => FieldValue | undefined }> }>
  | Readonly<{ status: "non_total"; missing_record_ids: readonly string[];
    witnessFor: (target: RecallTargetRef) => RecallNavigationWitness | undefined;
    values: Readonly<{ size: number; at: (index: number) => FieldValue | undefined }> }>
  | Readonly<{ status: "resource_refused";
    witnessFor: (target: RecallTargetRef) => RecallNavigationWitness | undefined;
    values: Readonly<{ size: number; at: (index: number) => FieldValue | undefined }> }>;

function captureNativeNavigation(state: FieldEngineState, meter: SourceSemanticResourceLedger) {
    const digest = hashContentDigest(state.observation_query_text ?? "", fieldContractSha256);
    const lanes = new Map<NativeRouteLane["lane"], NativeRouteOccurrence[]>([
      ["original-lexical", []], ["original-vector", []], ["hint-lexical", []], ["hint-vector", []]
    ]);
    const timeOccurrences: NativeRouteOccurrence[] = [];
    const sourceKeys = new Map<string, string>();
    const pool = new Map<string, { record_id: string; catalog_position: number | null }>();
    const associations: { occurrence_reference: string; root_key: string; record_id: string }[] = [];
    const navigation = new Map<string, RecallNavigationWitness>();
    const catalog = new Map<string, RecallNavigationWitness>();
    for (const target of state.native_sources?.admitted_roots ?? []) {
      const key = sourceFactKey(target), position = state.native_sources?.catalog_positions?.[sourceGoldRootIdentity(target)];
      meter.charge(1, 0, "bound source catalog position");
      pool.set(key, { record_id: key, catalog_position: position ?? null });
      if (position !== undefined) catalog.set(key, { contract: "native-query-navigation.v1", query_digest: digest,
        view: "original", operator: "bound_catalog", ordinal: position, reference: `catalog:${position}` });
    }
    const memory: NativeRouteOccurrence[] = [];
    const append = (key: string, occurrence: NativeRouteOccurrence, witness: RecallNavigationWitness) => {
      meter.charge(1, 0, "field navigation occurrence");
      if (!pool.has(key)) pool.set(key, { record_id: key, catalog_position: null });
      associations.push({ occurrence_reference: occurrence.reference, root_key: key, record_id: key });
      navigation.set(occurrence.reference, witness);
    };
    for (const occurrence of state.native_sources?.witness ?? []) {
      meter.charge(1, 0, "native occurrence scope association");
      const route = occurrence.route, key = sourceFactKey(occurrence.source.target);
      if (state.native_sources?.admitted_roots !== undefined && !pool.has(key)) continue;
      sourceKeys.set(occurrence.source.root_key, key);
      if (occurrence.domain !== undefined && (occurrence.view !== "original" || route.kind !== "lexical")) {
        throw new CoreError("OBLIGATION_VIOLATION", "Question-time capture requires original-query lexical provenance");
      }
      const lane = occurrence.domain === "question_time" ? timeOccurrences
        : lanes.get(`${occurrence.view}-${occurrence.route.kind}`)!;
      const queryDigest = state.native_sources?.navigation_digests?.[occurrence.view]
        ?? (occurrence.view === "original" ? state.native_sources?.result?.navigation_digest ?? undefined : undefined);
      if (queryDigest === undefined) throw new CoreError("OBLIGATION_VIOLATION", "Hint occurrence lacks its query identity");
      const window = route.kind === "vector" && route.window?.status === "available" ? route.window.window : undefined;
      const witness: RecallNavigationWitness = { contract: "native-query-navigation.v1", query_digest: queryDigest,
        view: occurrence.view, operator: route.kind === "lexical" ? "source_lexical" : "source_vector",
        ordinal: lane.length, native_rank: route.native_rank, reference: occurrence.reference,
        ...(occurrence.domain === undefined ? {} : { domain: occurrence.domain }),
        ...(window === undefined ? {} : { location: { start_byte: window.start_byte, end_byte: window.end_byte } }) };
      const row = { reference: occurrence.reference, root_key: key, native_rank: route.native_rank };
      append(key, row, witness); lane.push(row);
    }
    const seedRegions = state.residuals.filter(row => row.kind === "seed").map(row => `${row.region_id}:`);
    for (const observation of state.observations) {
      meter.charge(1, 0, "field navigation observation");
      if (!seedRegions.some(prefix => observation.observation_id.startsWith(prefix))
        || observation.applicability.verdict === "false") continue;
      const target = observation.target ?? memoryRecallTarget({ workspace_id: state.observation_workspace_id!,
        object_id: observation.object_id, source_revision: observation.source_revision });
      if (target.kind !== "memory_entry") continue;
      const key = sourceFactKey(target), reference = `memory:${observation.observation_id}`;
      const row = { reference, root_key: key, native_rank: memory.length + 1 };
      append(key, row, { contract: "native-query-navigation.v1", query_digest: digest, view: "original",
        operator: "memory_lexical", ordinal: memory.length, reference });
      memory.push(row);
    }
    const input = { lanes: [...lanes].map(([lane, occurrences]): NativeRouteLane => ({ lane, scope: digest,
      ...(occurrences.length === 0 ? { state: "measured-empty" } : { state: "exact-captured", occurrences }) })),
      memory: { lane: "memory-lexical" as const, scope: digest,
        ...(memory.length === 0 ? { state: "measured-empty" as const }
          : { state: "exact-captured" as const, occurrences: memory }) },
      pool: [...pool.values()], acquired_root_keys: [...new Set(associations.map(row => row.root_key))], associations,
      unvisited_sources: state.native_sources?.result?.completion !== "complete",
      ...(state.native_sources?.question_time_order === undefined ? {} : { question_time: {
        root_order: state.native_sources.question_time_order.map(key => sourceKeys.get(key) ?? key),
        capture: { lane: "question-time-lexical" as const, scope: digest,
          ...(timeOccurrences.length === 0 ? { state: "measured-empty" as const }
            : { state: "exact-captured" as const, occurrences: timeOccurrences }) }
      } }) };
    if (timeOccurrences.length > 0 && input.question_time === undefined) {
      throw new CoreError("OBLIGATION_VIOLATION", "Question-time capture lacks its bounded preference order");
    }
    // The ordering owner receives field-owned references and returns a bounded
    // trace. Charge that trace's containers, not a deep copy of the same values.
    meter.charge(4 + associations.length + pool.size, 128 * (associations.length + pool.size + 5), "field navigation frames");
    return { input, navigation, catalog };
}

export function nativeNavigationProjection(state: FieldEngineState, values: readonly FieldValue[],
  meter: SourceSemanticResourceLedger): NativeFieldNavigation {
  const witnesses = new Map<string, RecallNavigationWitness>();
  try {
    const { input, navigation, catalog } = captureNativeNavigation(state, meter);
    const ordered = orderNativeFieldAccess(input);
    // A bound source without a captured catalog position may still be returned,
    // but cannot manufacture a total navigation order or a native hit witness.
    const recordIds = "preferred_record_ids" in ordered ? ordered.preferred_record_ids
      : ordered.status === "ordered" ? ordered.record_ids
        : ordered.trace.filter(row => row.decision === "placed").map(row => row.record_id);
    const positions = new Map(recordIds.map((key, index) => [key, index]));
    for (const row of ordered.trace) if (row.decision === "placed") {
      const witness = { ...navigation.get(row.occurrence.reference)!, access_ordinal: positions.get(row.record_id)! };
      meter.charge(1, 0, "field access coordinate");
      witnesses.set(row.record_id, witness);
    }
    for (const [key, witness] of catalog) if (!witnesses.has(key) && positions.has(key)) {
      const placed = { ...witness, access_ordinal: positions.get(key)! };
      meter.charge(1, 0, "bound catalog access coordinate");
      witnesses.set(key, placed);
    }
    meter.charge(values.length, values.length * 8, "field navigation value references");
    const result = [...values].sort((left, right) => {
      meter.charge(1, 0, "field navigation comparison");
      return (positions.get(sourceFactKey(left.state.target)) ?? Number.MAX_SAFE_INTEGER)
        - (positions.get(sourceFactKey(right.state.target)) ?? Number.MAX_SAFE_INTEGER)
        || compareFieldValues(left, right, "canonical");
    });
    const shared = { witnessFor: (target: RecallTargetRef) => witnesses.get(sourceFactKey(target)),
      values: { size: result.length, at: (index: number) => result[index] } };
    return ordered.status === "ordered"
      ? { status: "ordered", ...shared }
      : { status: "non_total", missing_record_ids: ordered.missing_record_ids, ...shared };
  } catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
    // Never substitute another order on resource failure or commit a partial sort.
    return { status: "resource_refused" as const,
      witnessFor: (_target: RecallTargetRef): RecallNavigationWitness | undefined => undefined,
      values: { size: 0, at: (_index: number): FieldValue | undefined => undefined } };
  }
}
