import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { AlayaError, SourceEvidenceTargetSchema, SourceSemanticNominationOccurrenceSchema, canonicalJson } from "@do-soul/alaya-protocol";
import { FIELD_DELIVERY_LIMITS, FieldDeliverySchema, SourceContextRouteSchema, sourceContextRoute } from "./field-delivery.js";
import { navigationInventory } from "./conditional-navigation.js";
import { scoreConsumerByteVisibility, scoreConsumerMessageVisibility } from "../longmemeval-semantic/message-visibility.js";
import { ConditionalNavigationRunSchema, navigationFileDigest, frozenDeliveryPolicy, frozenDeliveryArms } from "./conditional-navigation-input.js";
import { FrozenNominationArtifactSchema, admitFrozenQueries } from "./conditional-navigation-frozen.js";
import { structuralNavigationStatus } from "./structural-navigation.js";

const Reference = z.object({ ordinal: z.number().int(), question_id: z.string(), arm: z.string(), status: z.string(),
  path: z.string().optional(), sha256: z.string().optional() }).passthrough();
const Receipt = z.object({ status: z.enum(["complete", "stopped"]), input_sha256: z.string(), formations_sha256: z.string(),
  rows: z.array(Reference), frozen_nominations: z.object({ artifact_sha256: z.string(), origin: z.unknown(), inherited_costs: z.unknown() }).optional() }).passthrough();
const Capture = z.object({ ordinal: z.number().int(), question_id: z.string(), arm: z.string(),
  frozen_nomination: z.object({ status: z.enum(["witnessed", "measured_empty", "unknown"]), capture_sha256: z.string() }).optional(),
  structural: z.object({
    nomination: z.object({ status: z.enum(["witnessed", "measured_empty", "unknown"]), completion: z.enum(["complete", "partial", "unknown"]),
      occurrence: z.object({ record_id: z.string(), occurrence: z.object({ reference: z.string() }).passthrough() }).passthrough().nullable() }),
    observation: z.object({ status: z.enum(["unobserved", "unknown", "observed"]),
      seed: z.object({ record_id: z.string(), prefix_bytes: z.number().int().positive() }).passthrough().nullable() }).passthrough()
  }).passthrough().optional(),
  field_delivery: z.object({ policy: FieldDeliverySchema, status: z.enum(["complete", "unavailable"]),
    selection: z.object({ rows: z.array(z.object({ record_id: z.string() }).passthrough()).max(FIELD_DELIVERY_LIMITS.slots) }).passthrough(),
    context_routes: z.array(z.object({ record_id: z.string(), route: SourceContextRouteSchema }).strict()).optional(),
    packing: z.object({ unique_utf8_bytes: z.number().int().nonnegative(),
      source_context_packing: z.array(z.object({ record_id: z.string(), status: z.enum(["complete", "partial", "omitted"]),
        read_start: z.number().int().nonnegative(), read_end: z.number().int().nonnegative(),
        delivered_start: z.number().int().nonnegative().nullable(), delivered_end: z.number().int().nonnegative().nullable() }).strict()).optional() }).passthrough(),
    missing_locations: z.array(z.object({ record_id: z.string(), reason: z.string() })) }).passthrough().optional(),
  solved: z.object({ rows: z.array(z.object({ record_id: z.string() }).passthrough()) }).passthrough(),
  captures: z.array(z.object({ condition: z.string(), witness: z.array(SourceSemanticNominationOccurrenceSchema) }).passthrough()),
  windows: z.array(z.object({ rank: z.number().int(), target: SourceEvidenceTargetSchema, start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(), text: z.string(), context_route: SourceContextRouteSchema.optional() }).passthrough()).max(FIELD_DELIVERY_LIMITS.slots),
  tail: z.object({ status: z.enum(["exhausted", "open", "unknown"]), reason: z.string() }) }).passthrough();
const GoldTarget = SourceEvidenceTargetSchema.unwrap().omit({ kind: true, evidence_object_id: true, span: true });
const LabelProjection = z.object({ rows: z.array(z.object({ arm: z.string(), visibility: z.object({
  gold_messages: z.object({ annotated: z.number().int().nonnegative(), complete: z.boolean() }).passthrough(),
  messages: z.array(z.object({ session_index: z.number().int(), message_index: z.number().int(), source_id: z.string(),
    target: GoldTarget, start: z.number().int(), end: z.number().int() }).passthrough()) }).passthrough() }).passthrough()) }).passthrough();
const Metrics = ["any_at_5", "any_at_10", "all_at_5", "all_at_10"] as const;
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
function check(test: boolean, message: string): asserts test { if (!test) throw new AlayaError("CONFLICT", message); }

/** All selected captures, including later rows, admit BEFORE opening the label manifest or any labels.
 * Failed/unavailable arms remain unscored, never successful original-only substitutes. */
function admitNavigationSelection(root: string, input: z.infer<typeof ConditionalNavigationRunSchema>, receipt: z.infer<typeof Receipt>) {
  const expectedArms = input.frozen_nominations ? frozenDeliveryArms(input).map(([arm]) => arm) : input.comparison ? ["original", "mechanical", "model"] : ["supplied"];
  check((input.frozen_nominations !== undefined) === (receipt.frozen_nominations !== undefined), "frozen nomination receipt drift");
  const frozen = receipt.frozen_nominations ? (() => {
    check(navigationFileDigest(join(root, "frozen-nominations.json")) === receipt.frozen_nominations!.artifact_sha256,
      "frozen nomination evidence drift");
    const artifact = FrozenNominationArtifactSchema.parse(readJson(join(root, "frozen-nominations.json")));
    check(canonicalJson(artifact.origin) === canonicalJson(receipt.frozen_nominations!.origin)
      && artifact.origin.receipt_sha256 === input.frozen_nominations!.receipt.sha256
      && artifact.rows.length === input.rows.length
      && new Set(artifact.rows.map(row => row.ordinal)).size === artifact.rows.length
      && artifact.rows.every(item => input.rows.some(row => row.ordinal === item.ordinal && row.question_id === item.question_id)),
    "frozen nomination origin/membership drift");
    return artifact;
  })() : undefined;
  check(receipt.status === "complete" ? receipt.rows.length === input.rows.length * expectedArms.length
    : receipt.rows.length <= input.rows.length * expectedArms.length, "incomplete selected capture membership");
  check(receipt.rows.every(ref => input.rows.some(row => row.ordinal === ref.ordinal && row.question_id === ref.question_id)
    && expectedArms.includes(ref.arm)), "unexpected selected capture membership");
  const admitted = input.rows.flatMap(row => expectedArms.map(arm => {
    const matches = receipt.rows.filter(ref => ref.ordinal === row.ordinal && ref.question_id === row.question_id && ref.arm === arm);
    check(matches.length <= 1 && (matches.length === 1 || receipt.status === "stopped"), "ambiguous selected capture membership");
    if (matches.length === 0) return { ref: { ordinal: row.ordinal, question_id: row.question_id, arm,
      status: "selection_not_captured" }, capture: null };
    const ref = matches[0]!;
    if (!["complete", "structure_unknown", "structure_unobserved", "delivery_unavailable", ...(frozen ? ["nomination_unknown"] : [])].includes(ref.status)) { check(!frozen && ref.status.startsWith("formation_"), "failed selection cannot score"); return { ref, capture: null }; }
    check(ref.path !== undefined && ref.path === basename(ref.path) && ref.sha256 !== undefined, "unbound selected capture");
    check(navigationFileDigest(join(root, ref.path)) === ref.sha256, "selected capture digest drift");
    const capture = Capture.parse(readJson(join(root, ref.path)));
    check(capture.ordinal === row.ordinal && capture.question_id === row.question_id && capture.arm === arm, "selected input identity drift");
    check(new Set(capture.windows.map(window => window.target.root_id)).size === capture.windows.length, "duplicate delivered root");
    const field = capture.field_delivery;
    check(canonicalJson(field?.policy ?? null) === canonicalJson(input.frozen_nominations ? frozenDeliveryPolicy(input, arm) : row.delivery_policy ?? null), "delivery policy drift");
    const inherited = frozen?.rows.find(item => item.ordinal === row.ordinal);
    if (inherited) {
      const derived = admitFrozenQueries(row, inherited.captures);
      check(canonicalJson(capture.captures) === canonicalJson(inherited.captures)
        && canonicalJson(capture.solved.rows) === canonicalJson(derived.solved.rows)
        && canonicalJson(capture.pool) === canonicalJson(derived.pool)
        && canonicalJson(capture.occurrences) === canonicalJson(derived.occurrences)
        && inherited.nomination === derived.nomination && capture.frozen_nomination?.status === derived.nomination
        && capture.frozen_nomination.capture_sha256 === inherited.capture_sha256,
      "frozen execution nomination/order drift");
      check((ref.status === "nomination_unknown") === (derived.nomination === "unknown")
        && canonicalJson(field?.selection.rows) === canonicalJson(derived.solved.rows.slice(0, FIELD_DELIVERY_LIMITS.slots)),
      "frozen matched selection/status drift");
    }
    if (field) {
      check(capture.tail.status === (capture.solved.rows.length <= capture.windows.length ? "exhausted" : "open"),
        "packed delivery tail drift");
      check(new Set(field.selection.rows.map(s => s.record_id)).size === field.selection.rows.length
        && field.selection.rows.every(s => capture.solved.rows.some(r => r.record_id === s.record_id)), "selected root outside solved field");
      check(field.packing.unique_utf8_bytes === capture.windows.reduce((n, w) => n + Buffer.byteLength(w.text), 0)
        && field.packing.unique_utf8_bytes <= field.policy.byte_budget, "delivery byte accounting drift");
      check((field.status === "unavailable") === (field.missing_locations.length > 0)
        && (ref.status === "nomination_unknown" || (ref.status === "delivery_unavailable") === (field.status === "unavailable")), "delivery availability drift");
    }
    if (field?.policy.windows === "source-context") admitSourceContexts(capture);
    else check(capture.windows.every(window => window.context_route === undefined), "non-context route annotation drift");
    for (const [i, window] of capture.windows.entries()) {
      check(window.rank === i + 1 && (field?.policy.windows === "native-anchor" || window.context_route === "native-anchor" || window.start === 0)
        && Buffer.byteLength(window.text) === window.end - window.start
        && window.target.workspace_id === row.workspace && (field
          ? field.selection.rows.some(item => item.record_id === window.target.root_id)
          : capture.solved.rows[i]?.record_id === window.target.root_id)
        && capture.captures.some(query => query.witness.some(hit => canonicalJson(hit.source.target) === canonicalJson(window.target))),
      "selected literal window admission failed");
      if (field?.policy.windows === "native-anchor" || window.context_route === "native-anchor") check(capture.captures.some(query => query.witness.some(hit =>
        canonicalJson(hit.source.target) === canonicalJson(window.target) && hit.route.kind === "vector"
        && hit.route.window?.status === "available" && window.start === hit.route.window.window.start_byte
        && window.end <= hit.route.window.window.end_byte)), "delivered window lacks a bound native anchor");
      if (field && i > 0) check(field.selection.rows.findIndex(s => s.record_id === capture.windows[i - 1]!.target.root_id)
        < field.selection.rows.findIndex(s => s.record_id === window.target.root_id), "delivered selection order drift");
    }
    const unavailableStructure = admitStructuralAvailability(row, ref.status === "delivery_unavailable" || ref.status === "nomination_unknown" ? undefined : ref.status, capture);
    return { ref, capture: unavailableStructure || field?.status === "unavailable" || ref.status === "nomination_unknown" ? null : capture };
  }));
  return { admitted, expectedArms };
}

/** Recompute routing from the admitted full witness, not from a prefix presented
 * as an anchor. Read extent and packed extent deliberately remain distinct. */
function admitSourceContexts(capture: z.infer<typeof Capture>) {
  const field = capture.field_delivery!, { targets } = navigationInventory(capture.captures);
  const witnesses = capture.captures.flatMap(query => query.witness);
  const routes = field.selection.rows.map(({ record_id }) => ({ record_id, route: sourceContextRoute(targets.get(record_id)!, witnesses) }));
  check(canonicalJson(routes) === canonicalJson(field.context_routes), "source context route drift");
  const missing = field.missing_locations.map(item => item.record_id);
  check(new Set(missing).size === missing.length && missing.every(id => routes.some(item => item.record_id === id))
    && routes.every(item => item.route !== "unavailable" || missing.includes(item.record_id)), "source context availability drift");
  const packing = field.packing.source_context_packing ?? [];
  check(canonicalJson(packing.map(item => item.record_id)) === canonicalJson(routes.filter(item => !missing.includes(item.record_id)).map(item => item.record_id)),
    "source context read membership drift");
  for (const item of packing) {
    const route = routes.find(r => r.record_id === item.record_id)!.route, source = targets.get(item.record_id)!;
    const window = capture.windows.find(w => w.target.root_id === item.record_id);
    check(item.read_end >= item.read_start && item.read_end - item.read_start <= FIELD_DELIVERY_LIMITS.window_bytes
      && item.read_end <= source.body_bytes, "source context read extent drift");
    if (route !== "native-anchor") check(item.read_start === 0 && (route !== "whole-source" || item.read_end === source.body_bytes),
      "source context whole/prefix extent drift");
    check(item.delivered_start === (window?.start ?? null) && item.delivered_end === (window?.end ?? null)
      && item.status === (!window ? "omitted" : window.start === item.read_start && window.end === item.read_end ? "complete" : "partial")
      && (!window || window.context_route === route && window.start === item.read_start && window.end <= item.read_end), "source context packing drift");
  }
  check(capture.windows.every(window => packing.some(item => item.record_id === window.target.root_id)), "source context window lacks read admission");
}

export function evaluateConditionalNavigation(root: string, labelManifestPath: string, output: string) {
  check(!existsSync(output), "evaluation output must be new");
  const receipt = Receipt.parse(readJson(join(root, "receipt.json")));
  check(navigationFileDigest(join(root, "input.json")) === receipt.input_sha256
    && navigationFileDigest(join(root, "formations.json")) === receipt.formations_sha256, "frozen input/formation drift");
  const input = ConditionalNavigationRunSchema.parse(readJson(join(root, "input.json")));
  const { admitted, expectedArms } = admitNavigationSelection(root, input, receipt);
  // Nothing above this point has label access. There is no retrieval entry after it.
  const labels = z.array(z.object({ ordinal: z.number().int(), path: z.string() }).strict()).parse(readJson(labelManifestPath));
  const gold = new Map(input.rows.map(row => {
    const matches = labels.filter(label => label.ordinal === row.ordinal); check(matches.length === 1, "ambiguous label membership");
    const path = matches[0]!.path, projection = LabelProjection.parse(readJson(path));
    const visibility = projection.rows.find(item => item.arm === "C")?.visibility;
    check(visibility !== undefined, "accepted evaluator projection missing");
    return [row.ordinal, { path, sha256: navigationFileDigest(path), value: { unit: "published_body_utf8_bytes" as const,
      annotated_turns: visibility.gold_messages.annotated, complete: visibility.gold_messages.complete,
      spans: visibility.messages.map(({ session_index, message_index, source_id, target, start, end }) =>
        ({ session_index, message_index, source_id, target, start, end })) } }];
  }));
  const rows = admitted.map(({ ref, capture }) => {
    const label = gold.get(ref.ordinal)!;
    return { ordinal: ref.ordinal, question_id: ref.question_id, arm: ref.arm, status: ref.status,
      evaluator_projection: { path: label.path, sha256: label.sha256 },
      visibility: capture === null ? null : scoreConsumerMessageVisibility({ gold: label.value, pages: [{ page: 1,
        status: "observed", reason: null, occupied_slots: capture.windows.length, complete: true,
        continuation: capture.tail.status === "exhausted" ? "none" : "present", terminal_tail: capture.tail,
        intervals: capture.windows.map(({ rank, target, start, end }) => ({ rank, target, start, end })) }] }),
      byte_visibility: capture?.field_delivery ? scoreConsumerByteVisibility({ gold: label.value,
        windows: capture.windows, byte_budget: capture.field_delivery.policy.byte_budget,
        unique_utf8_bytes: capture.field_delivery.packing.unique_utf8_bytes }) : null,
      visible_utf8_bytes: capture?.windows.reduce((sum, window) => sum + Buffer.byteLength(window.text), 0) ?? null };
  });
  // Pair availability must not suppress an otherwise scorable arm's own metrics.
  const baseline = input.frozen_nominations ? frozenDeliveryArms(input)[0]![0] : "original";
  const originalAvailable = rows.every(row => row.arm !== baseline || row.visibility !== null);
  const summary = expectedArms.map(arm => {
    const selected = rows.filter(row => row.arm === arm), complete = selected.every(row => row.visibility !== null);
    const counts = complete ? Object.fromEntries(Metrics.map(metric => [metric, Object.fromEntries(["hit", "miss", "unknown"].map(status =>
      [status, selected.filter(row => row.visibility![metric].status === status).length]))])) : null;
    const pairs = arm === baseline || arm === "supplied" || !complete || !originalAvailable ? null : Object.fromEntries(Metrics.map(metric => {
      const outcomes = selected.map(row => [rows.find(base => base.ordinal === row.ordinal && base.arm === baseline)!.visibility![metric].status,
        row.visibility![metric].status]);
      return [metric, { gains: outcomes.filter(([a, b]) => a === "miss" && b === "hit").length,
        losses: outcomes.filter(([a, b]) => a === "hit" && b === "miss").length,
        unknown_pairs: outcomes.filter(([a, b]) => a === "unknown" || b === "unknown").length }];
    }));
    return { arm, status: complete ? "scored" : "unavailable",
      denominator: selected.length, metrics: counts, paired: pairs };
  });
  const result = { contract: "conditional-navigation-evaluation.v2", exposed_development_data: true,
    receipt_sha256: navigationFileDigest(join(root, "receipt.json")), summary, rows };
  writeFileSync(output, JSON.stringify(result, null, 2), { flag: "wx" });
  return result;
}

/** Diagnostic windows do not make an unobserved structural intervention available.
 * Bind the seed back to the original query's actual retained nomination witness. */
function admitStructuralAvailability(row: z.infer<typeof ConditionalNavigationRunSchema>["rows"][number],
  status: string | undefined, capture: z.infer<typeof Capture>) {
  if (!row.structural_navigation || row.structural_navigation.mode === "off") {
    check(status === undefined || status === "complete", "disabled structural availability drift"); return false;
  }
  const structure = capture.structural;
  check(structure !== undefined, "structural nomination/read observation missing");
  const { nomination, observation } = structure, nominee = nomination.occurrence;
  const witnesses = capture.captures.find(query => query.condition === row.original)?.witness;
  check(witnesses !== undefined, "original nomination witness missing");
  if (nomination.status === "witnessed") {
    check(nominee !== null && witnesses.some(witness => witness.source.target.root_id === nominee.record_id
      && `${row.original}:${witness.reference}` === nominee.occurrence.reference), "structural seed lacks original nomination witness");
    check(observation.seed?.record_id === nominee.record_id && observation.status !== "unobserved", "structural nominated seed read missing");
  } else {
    check(nominee === null && witnesses.length === 0 && observation.seed === null && observation.status === "unobserved",
      "unwitnessed structural seed or observation");
    check((nomination.status === "measured_empty") === (nomination.completion === "complete"), "original nomination completeness drift");
  }
  const expected = structuralNavigationStatus(row.structural_navigation.mode, nomination.status, observation.status);
  check(status === undefined || status === expected, "structural availability drift");
  return expected !== "complete";
}
