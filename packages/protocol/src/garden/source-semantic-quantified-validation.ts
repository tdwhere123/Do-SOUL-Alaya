import type { SourceSemanticGraph, SourceSemanticSupport } from "./source-semantic-draft.js";
import { sourceSemanticContextContains } from "./source-semantic-structure.js";

/** Binder scope and evidence references are checked before any finite lowering. */
export function refineSourceSemanticQuantification(graph: SourceSemanticGraph, problem: (message: string) => void): void {
  const occurrences = new Map([...graph.frames, ...graph.operators].map((row) => [row.id, row]));
  const referents = new Set(graph.referents.map((row) => row.id));
  const mentions = new Set(graph.mentions.map((row) => row.id));
  const domains = new Map((graph.domains ?? []).map((row) => [row.id, row]));
  const ids = [...mentions, ...referents, ...occurrences.keys(), ...domains.keys(), ...(graph.measurements ?? []).map((row) => row.id)];
  if (new Set(ids).size !== ids.length || domains.size !== (graph.domains?.length ?? 0)) problem("duplicate semantic handles");
  const occurrence = (id: string) => { if (!occurrences.has(id)) problem("unknown quantified evidence occurrence"); };
  const evidenceInContext = (id: string, context: string | null) => {
    occurrence(id);
    const owner = occurrences.get(id)?.context_owner;
    const valid = context === null ? owner?.kind === "source_act" && owner.source_act === "assertion"
      : owner?.kind === "embedding" ? owner.parent_frame === context
      : owner?.kind === "operator" && owner.operator_handle === context;
    if (!valid) problem("quantified evidence escapes its declared context");
  };
  const support = (rows: readonly SourceSemanticSupport[]) => {
    for (const row of rows) {
      if (row.kind === "dominating") occurrence(row.via_id);
      else if (row.mentions.some((id) => !mentions.has(id))) problem("unknown quantified support mention");
    }
  };
  for (const domain of domains.values()) {
    support(domain.support);
    if (domain.context !== null) occurrence(domain.context);
    const members = domain.members.map((row) => row.referent);
    const exclusions = domain.exclusions.map((row) => row.referent);
    if (new Set(members).size !== members.length || new Set(exclusions).size !== exclusions.length
      || exclusions.some((id) => members.includes(id))) problem("domain membership is duplicated or contradictory");
    for (const member of [...domain.members, ...domain.exclusions]) {
      if (!referents.has(member.referent)) problem("domain membership requires a declared referent");
      evidenceInContext(member.evidence, domain.context);
    }
    for (const member of domain.members) for (const restriction of member.restrictions) {
      occurrence(restriction.restriction); evidenceInContext(restriction.evidence, domain.context);
      if (!graph.operators.some((row) => row.operator === "forall" && row.domain === domain.id
        && row.restriction === restriction.restriction)) problem("member restriction does not belong to a rule in its domain");
    }
    if (domain.closure.kind === "closed") evidenceInContext(domain.closure.evidence, domain.context);
  }
  for (const operator of graph.operators) if (operator.operator === "forall") {
    if (graph.operators.some((other) => other.operator === "forall" && other.id !== operator.id
      && sourceSemanticContextContains(graph, other.id, operator.id))) problem("nested universal binders are not supported by this finite contract");
    if (!domains.has(operator.domain)) problem("forall requires a declared domain");
    const domain = domains.get(operator.domain);
    if (domain?.context != null && !sourceSemanticContextContains(graph, domain.context, operator.id)) problem("forall escapes its domain context");
    if (operator.restriction !== null) {
      occurrence(operator.restriction);
      if (!sourceSemanticContextContains(graph, operator.id, operator.restriction)) problem("restriction escapes its quantifier scope");
    }
    if (!graph.frames.some((frame) => sourceSemanticContextContains(graph, operator.content, frame.id)
      && frame.bindings.some((binding) => binding.target.kind === "bound_variable"
        && binding.target.quantifier === operator.id && binding.target.binder === operator.binder))) {
      problem("universal binder must occur in its body");
    }
  }
  for (const frame of graph.frames) for (const binding of frame.bindings) {
    if (binding.target.kind !== "bound_variable") continue;
    const target = binding.target, owner = graph.operators.find((row) => row.id === target.quantifier);
    if (owner?.operator !== "forall" || owner.binder !== target.binder
      || !sourceSemanticContextContains(graph, owner.id, frame.id)) problem("bound variable escapes its declared quantifier");
  }
  const measurementValues = new Map<string, string>();
  for (const measurement of graph.measurements ?? []) {
    if (!referents.has(measurement.subject)) problem("measurement subject requires a declared referent");
    occurrence(measurement.owner);
    if (!domains.has(measurement.population)) problem("measurement requires a declared population");
    const domain = domains.get(measurement.population);
    if (domain !== undefined && (domain.exclusions.some((row) => row.referent === measurement.subject)
      || domain.closure.kind === "closed" && !domain.members.some((row) => row.referent === measurement.subject))) {
      problem("measurement subject contradicts its declared population");
    }
    if (domain?.context != null && !sourceSemanticContextContains(graph, domain.context, measurement.owner)) problem("measurement escapes its population context");
    support(measurement.support);
    const signature = JSON.stringify([measurement.subject, measurement.population, measurement.metric, measurement.unit, measurement.context]);
    const value = canonicalSourceSemanticDecimal(measurement.value), previous = measurementValues.get(signature);
    if (previous !== undefined && previous !== value) problem("conflicting measurement values require an explicit context distinction");
    measurementValues.set(signature, value);
  }
}

/** Decimal normalization is exact; no binary floating point or implicit unit conversion. */
export function canonicalSourceSemanticDecimal(value: string): string {
  const negative = value.startsWith("-"), unsigned = negative ? value.slice(1) : value;
  const [whole, rawFraction = ""] = unsigned.split(".");
  const fraction = rawFraction.replace(/0+$/u, "");
  const result = `${whole}${fraction.length === 0 ? "" : `.${fraction}`}`;
  return negative && result !== "0" ? `-${result}` : result;
}

export function compareSourceSemanticDecimals(left: string, right: string): -1 | 0 | 1 {
  const parts = (value: string) => {
    const [whole, fraction = ""] = canonicalSourceSemanticDecimal(value).split(".");
    return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
  };
  const a = parts(left), b = parts(right), scale = Math.max(a.scale, b.scale);
  const x = a.coefficient * 10n ** BigInt(scale - a.scale), y = b.coefficient * 10n ** BigInt(scale - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}
