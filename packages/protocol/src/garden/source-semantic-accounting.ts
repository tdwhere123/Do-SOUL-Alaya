import { AlayaError } from "../shared/alaya-error.js";
import { canonicalJson } from "../recall/selection/capture/canonical-json.js";
import type { SourceReferenceCatalog } from "../evidence/source-reference.js";
import {
  SOURCE_SEMANTIC_PACKET_CONTRACT, SourceSemanticDraftSchema,
  type SourceSemanticDraft, type SourceSemanticGraph, type SourceSemanticGap,
  type SourceSemanticSupport
} from "./source-semantic-draft.js";
import { sourceSemanticStructuralEdges } from "./source-semantic-structure.js";
import { SourceSemanticResourceExhausted, type SourceSemanticResourceLedger } from "./source-semantic-resources.js";

/** Accounts for structural omissions only. Source fidelity remains unreviewed. */
export function accountSourceSemanticDraft(
  graph: SourceSemanticGraph, catalog: SourceReferenceCatalog, meter?: SourceSemanticResourceLedger
): SourceSemanticDraft {
  // Reserve linear index/copy work before allocating it. Traversal and the expanded
  // result are charged separately; this is a logical budget, not an RSS estimate.
  meter?.retain(graph, "source accounting indexes");
  meter?.retain(catalog, "source accounting assertion indexes");
  const mentions = graph.mentions.map(({ id, assertion_id, source_ref }) => ({ id, assertion_id, source_ref }));
  const gaps = [...graph.gaps];
  const links = evidenceLinks(graph);
  const accounted = reachableEvidence(links, [
    ...graph.frames.map((row) => row.id), ...graph.operators.map((row) => row.id),
    ...(graph.domains ?? []).map((row) => row.id), ...(graph.measurements ?? []).map((row) => row.id),
    ...gaps.flatMap((gap) => [...gap.affected_ids, ...supportHandles(gap.support)])
  ], meter);
  for (const row of [...graph.referents, ...graph.mentions]) {
    if (accounted.has(row.id)) continue;
    const evidence = "mentions" in row ? row.mentions : [row.id];
    gaps.push({ kind: "uninterpreted_clause", affected_ids: [row.id],
      support: evidence.slice(0, 8).map((id) => ({ kind: "lexical", mentions: [id] })),
      description: "Declared source evidence is not connected to an interpretation occurrence or located gap." });
    for (const id of reachableEvidence(links, [row.id], meter)) accounted.add(id);
  }
  const assertionIds = new Set(mentions.filter((row) => accounted.has(row.id)).map((row) => row.assertion_id));
  const ids = new Set(links.keys());
  for (const row of catalog.assertions) {
    if (assertionIds.has(row.assertion_id)) continue;
    let id = `hostAssertion${row.assertion_id}`;
    let suffix = 0;
    while (ids.has(id)) id = `hostAssertion${row.assertion_id}_${++suffix}`;
    ids.add(id);
    mentions.push({ id, assertion_id: row.assertion_id,
      source_ref: { first: row.segments[0]!.id, last: row.segments.at(-1)!.id } });
    gaps.push({ kind: "uninterpreted_clause", affected_ids: [id],
      support: [{ kind: "lexical", mentions: [id] }],
      description: "No interpretation or located gap accounts for this selected source assertion." });
  }
  accountMissingBindings(graph, gaps);
  const result = { contract: SOURCE_SEMANTIC_PACKET_CONTRACT, mentions,
    referents: graph.referents, frames: graph.frames, operators: graph.operators, gaps,
    ...(graph.domains === undefined ? {} : { domains: graph.domains }),
    ...(graph.measurements === undefined ? {} : { measurements: graph.measurements }) };
  meter?.retain(result, "source interpretation accounting");
  const parsed = SourceSemanticDraftSchema.safeParse(result);
  if (!parsed.success) {
    if (parsed.error.issues.some((issue) => issue.code === "too_big"
      || issue.message === "source semantic graph exceeds its byte bound")) {
      throw new SourceSemanticResourceExhausted("source accounting expansion");
    }
    throw parsed.error;
  }
  return parsed.data;
}

/** A normalized entrance must carry the same omissions; never silently rewrite its identity. */
export function assertSourceSemanticAccounting(
  graph: SourceSemanticGraph, catalog: SourceReferenceCatalog, meter?: SourceSemanticResourceLedger
): void {
  const accounted = accountSourceSemanticDraft(graph, catalog, meter);
  if (accounted.mentions.length !== graph.mentions.length || canonicalJson(accounted.gaps) !== canonicalJson(graph.gaps)) {
    throw new AlayaError("VALIDATION", "interpretation omits host-derived source accounting gaps");
  }
}

function supportHandles(supports: readonly SourceSemanticSupport[]): string[] {
  return supports.flatMap((support) => support.kind === "dominating" ? [support.via_id] : support.mentions);
}

function evidenceLinks(graph: SourceSemanticGraph): Map<string, readonly string[]> {
  const links = new Map<string, string[]>();
  for (const row of graph.mentions) links.set(row.id, []);
  for (const row of graph.referents) links.set(row.id, [...row.mentions]);
  for (const row of graph.frames) links.set(row.id, [
    ...(row.predicate_support.kind === "explicit" ? row.predicate_support.mentions : row.predicate_support.supporting_context),
    ...supportHandles(row.additional_support), ...row.slots.flatMap((slot) => supportHandles(slot.support)),
    ...row.bindings.flatMap((binding) => [...supportHandles(binding.support),
      ...(binding.target.kind === "node" ? [binding.target.id] : [])])
  ]);
  for (const row of graph.operators) links.set(row.id, supportHandles(row.additional_support));
  for (const edge of sourceSemanticStructuralEdges(graph)) links.get(edge.from)!.push(edge.to);
  for (const row of graph.domains ?? []) links.set(row.id, [
    ...supportHandles(row.support), ...row.members.flatMap((member) => [member.referent, member.evidence,
      ...member.restrictions.flatMap((restriction) => [restriction.restriction, restriction.evidence])]),
    ...row.exclusions.flatMap((exclusion) => [exclusion.referent, exclusion.evidence]),
    ...(row.closure.kind === "closed" ? [row.closure.evidence] : [])
  ]);
  for (const row of graph.measurements ?? []) links.set(row.id,
    [row.subject, row.owner, row.population, ...supportHandles(row.support)]);
  return links;
}

function reachableEvidence(
  links: ReadonlyMap<string, readonly string[]>, roots: readonly string[], meter?: SourceSemanticResourceLedger
): Set<string> {
  const seen = new Set<string>(), pending = [...roots];
  while (pending.length !== 0) {
    meter?.charge(1, 0, "source accounting evidence traversal");
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(links.get(id) ?? []));
  }
  return seen;
}

function accountMissingBindings(graph: SourceSemanticGraph, gaps: SourceSemanticGap[]): void {
  const located = new Set(gaps.filter((gap) => gap.kind === "missing_binding").flatMap((gap) => gap.affected_ids));
  const embedded = new Map<string, string[]>();
  for (const row of [...graph.frames, ...graph.operators]) {
    if (row.context_owner.kind !== "embedding") continue;
    const children = embedded.get(row.context_owner.parent_frame) ?? [];
    children.push(row.id);
    embedded.set(row.context_owner.parent_frame, children);
  }
  for (const frame of graph.frames) {
    const boundSlots = new Set(frame.bindings.filter((binding) => binding.target.kind !== "unresolved")
      .map((binding) => binding.slot_id));
    const boundNodes = new Set(frame.bindings.flatMap((binding) => binding.target.kind === "node" ? [binding.target.id] : []));
    const missing = frame.slots.filter((slot) => !boundSlots.has(slot.id));
    const children = (embedded.get(frame.id) ?? []).filter((id) => !boundNodes.has(id));
    if (missing.length === 0 && children.length === 0) continue;
    if (located.has(frame.id)) continue;
    const mentions = frame.predicate_support.kind === "explicit"
      ? frame.predicate_support.mentions : frame.predicate_support.supporting_context;
    gaps.push({ kind: "missing_binding", affected_ids: [frame.id, ...children].slice(0, 64),
      support: [{ kind: "lexical", mentions }],
      description: `Unresolved slot bindings: ${missing.map((slot) => slot.id).join(", ") || "none"}; embedded occurrences without a parent binding: ${children.join(", ") || "none"}.`.slice(0, 1024) });
  }
}
