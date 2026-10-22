import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { AlayaError, SourceEvidenceTargetSchema, canonicalJson } from "@do-soul/alaya-protocol";
import { scoreConsumerMessageVisibility } from "../longmemeval-semantic/message-visibility.js";
import { ConditionalNavigationRunSchema, navigationFileDigest } from "./conditional-navigation-run.js";
import { structuralNavigationStatus } from "./structural-navigation.js";

const Reference = z.object({ ordinal: z.number().int(), question_id: z.string(), arm: z.string(), status: z.string(),
  path: z.string().optional(), sha256: z.string().optional() }).passthrough();
const Receipt = z.object({ status: z.literal("complete"), input_sha256: z.string(), formations_sha256: z.string(),
  rows: z.array(Reference) }).passthrough();
const Capture = z.object({ ordinal: z.number().int(), question_id: z.string(), arm: z.string(),
  structural: z.object({
    nomination: z.object({ status: z.enum(["witnessed", "measured_empty", "unknown"]), completion: z.enum(["complete", "partial", "unknown"]),
      occurrence: z.object({ record_id: z.string(), occurrence: z.object({ reference: z.string() }).passthrough() }).passthrough().nullable() }),
    observation: z.object({ status: z.enum(["unobserved", "unknown", "observed"]),
      seed: z.object({ record_id: z.string(), prefix_bytes: z.number().int().positive() }).passthrough().nullable() }).passthrough()
  }).passthrough().optional(),
  solved: z.object({ rows: z.array(z.object({ record_id: z.string() }).passthrough()) }).passthrough(),
  captures: z.array(z.object({ condition: z.string(), witness: z.array(z.object({ reference: z.string(),
    source: z.object({ target: SourceEvidenceTargetSchema }).passthrough() }).passthrough()) }).passthrough()),
  windows: z.array(z.object({ rank: z.number().int(), target: SourceEvidenceTargetSchema, start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(), text: z.string() }).passthrough()).max(10),
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
export function evaluateConditionalNavigation(root: string, labelManifestPath: string, output: string) {
  check(!existsSync(output), "evaluation output must be new");
  const receipt = Receipt.parse(readJson(join(root, "receipt.json")));
  check(navigationFileDigest(join(root, "input.json")) === receipt.input_sha256
    && navigationFileDigest(join(root, "formations.json")) === receipt.formations_sha256, "frozen input/formation drift");
  const input = ConditionalNavigationRunSchema.parse(readJson(join(root, "input.json")));
  const expectedArms = input.comparison ? ["original", "mechanical", "model"] : ["supplied"];
  check(receipt.rows.length === input.rows.length * expectedArms.length, "incomplete selected capture membership");
  const admitted = input.rows.flatMap(row => expectedArms.map(arm => {
    const matches = receipt.rows.filter(ref => ref.ordinal === row.ordinal && ref.question_id === row.question_id && ref.arm === arm);
    check(matches.length === 1, "ambiguous selected capture membership");
    const ref = matches[0]!;
    if (!["complete", "structure_unknown", "structure_unobserved"].includes(ref.status)) { check(ref.status.startsWith("formation_"), "failed selection cannot score"); return { ref, capture: null }; }
    check(ref.path !== undefined && ref.path === basename(ref.path) && ref.sha256 !== undefined, "unbound selected capture");
    check(navigationFileDigest(join(root, ref.path)) === ref.sha256, "selected capture digest drift");
    const capture = Capture.parse(readJson(join(root, ref.path)));
    check(capture.ordinal === row.ordinal && capture.question_id === row.question_id && capture.arm === arm, "selected input identity drift");
    check(new Set(capture.windows.map(window => window.target.root_id)).size === capture.windows.length, "duplicate delivered root");
    for (const [i, window] of capture.windows.entries()) {
      check(window.rank === i + 1 && window.start === 0 && Buffer.byteLength(window.text) === window.end - window.start
        && window.target.workspace_id === row.workspace && capture.solved.rows[i]?.record_id === window.target.root_id
        && capture.captures.some(query => query.witness.some(hit => canonicalJson(hit.source.target) === canonicalJson(window.target))),
      "selected literal window admission failed");
    }
    const unavailableStructure = admitStructuralAvailability(row, ref.status, capture);
    return { ref, capture: unavailableStructure ? null : capture };
  }));
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
      visible_utf8_bytes: capture?.windows.reduce((sum, window) => sum + Buffer.byteLength(window.text), 0) ?? null };
  });
  const summary = expectedArms.map(arm => {
    const selected = rows.filter(row => row.arm === arm), complete = selected.every(row => row.visibility !== null);
    const counts = complete ? Object.fromEntries(Metrics.map(metric => [metric, Object.fromEntries(["hit", "miss", "unknown"].map(status =>
      [status, selected.filter(row => row.visibility![metric].status === status).length]))])) : null;
    const pairs = arm === "original" || arm === "supplied" || !complete ? null : Object.fromEntries(Metrics.map(metric => {
      const outcomes = selected.map(row => [rows.find(base => base.ordinal === row.ordinal && base.arm === "original")!.visibility![metric].status,
        row.visibility![metric].status]);
      return [metric, { gains: outcomes.filter(([a, b]) => a === "miss" && b === "hit").length,
        losses: outcomes.filter(([a, b]) => a === "hit" && b === "miss").length,
        unknown_pairs: outcomes.filter(([a, b]) => a === "unknown" || b === "unknown").length }];
    }));
    return { arm, status: complete ? "scored" : "unavailable",
      denominator: complete || selected.some(row => row.status.startsWith("structure_")) ? selected.length : null, metrics: counts, paired: pairs };
  });
  const result = { contract: "input-condition-formation-evaluation.v1", exposed_development_data: true,
    receipt_sha256: navigationFileDigest(join(root, "receipt.json")), summary, rows };
  writeFileSync(output, JSON.stringify(result, null, 2), { flag: "wx" });
  return result;
}

/** Diagnostic windows do not make an unobserved structural intervention available.
 * Bind the seed back to the original query's actual retained nomination witness. */
function admitStructuralAvailability(row: z.infer<typeof ConditionalNavigationRunSchema>["rows"][number],
  status: string, capture: z.infer<typeof Capture>) {
  if (!row.structural_navigation || row.structural_navigation.mode === "off") {
    check(status === "complete", "disabled structural availability drift"); return false;
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
  check(status === expected, "structural availability drift");
  return expected !== "complete";
}
