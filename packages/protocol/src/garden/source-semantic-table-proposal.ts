import { sourceSemanticProducerEnvelopeViolation } from "./source-semantic-producer-envelope.js";
import { AlayaError } from "../shared/alaya-error.js";
import { SOURCE_SEMANTIC_MAX_DEPTH } from "./source-semantic-draft.js";
import { compileSourceSemanticSelection } from "./source-semantic-selection-lowering.js";
import { SourceSemanticResourceLedger } from "./source-semantic-resources.js";
import type { SourceReferenceCatalog } from "../evidence/source-reference.js";
import type { FieldContractSha256 } from "../recall/field-contract/canonical-identity.js";
import { SourceSemanticTableProposalSchema, SOURCE_SEMANTIC_TABLE_LIMIT as LIMIT,
  type SourceSemanticTableContent as Content, type SourceSemanticTableNode as Node,
  type SourceSemanticTableTarget as TargetValue, type SourceSemanticTableOperand as OperandValue
} from "./source-semantic-table-shape.js";
export { SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT, SOURCE_SEMANTIC_TABLE_GENERATION_CONTRACT,
  sourceSemanticTableJsonSchema } from "./source-semantic-table-shape.js";

/** A producer-authored table violates the table ownership contract. */
export class SourceSemanticTableValidationError extends AlayaError {
  constructor(code: string, key: string) {
    super("VALIDATION", `${code}: ${key}`);
    this.name = "SourceSemanticTableValidationError";
  }
}

function fail(code: string, key: string): never { throw new SourceSemanticTableValidationError(code, key); }
function references(node: Node): readonly OperandValue[] {
  if (node.kind === "statement") return [...node.arguments, ...node.qualifications]
    .flatMap(row => row.target.kind === "content_ref" || row.target.kind === "content_reference" ? [row.target] : []);
  if (node.kind === "conditional") return [node.antecedent, node.consequent];
  if (node.kind === "opaque") return node.operands;
  if (node.kind === "forall") return node.restriction === null ? [node.content] : [node.restriction, node.content];
  return [node.content];
}

/** Validate the finite ownership graph before expanding a single node. */
function index(content: Content, meter: SourceSemanticResourceLedger) {
  const nodes = new Map<string, Node>(), entities = new Map<string, Content["entities"][number]>();
  const materializedEntities = new Set<string>();
  let frames = 0, operators = 0;
  for (const entity of content.entities) {
    meter.charge(1, 96, "table entity index");
    if (entities.has(entity.key)) fail("duplicate_entity", entity.key);
    entities.set(entity.key, entity);
  }
  for (const node of content.nodes) {
    meter.charge(1, 96, "table occurrence index");
    if (nodes.has(node.key)) fail("duplicate_occurrence", node.key);
    if (node.kind === "statement" ? ++frames > LIMIT.frames : ++operators > LIMIT.operators) {
      fail("native_occurrence_capacity_exceeded", node.key);
    }
    if (node.kind === "statement" && node.arguments.length + node.qualifications.length > LIMIT.arguments) {
      fail("argument_capacity_exceeded", node.key);
    }
    nodes.set(node.key, node);
  }
  const owner = new Map<string, string>(), root = new Map<string, string>();
  const edges = new Map<string, string[]>();
  for (const node of content.nodes) {
    const children: string[] = [];
    for (const ref of references(node)) {
      if (ref.kind !== "content_ref") continue;
      if (!nodes.has(ref.key)) fail("missing_content", ref.key);
      if (owner.has(ref.key)) fail("ambiguous_content_owner", ref.key);
      owner.set(ref.key, node.key); children.push(ref.key);
    }
    edges.set(node.key, children);
    const targets = node.kind === "statement" ? [...node.arguments, ...node.qualifications].map(row => row.target) : [];
    for (const target of targets) {
      if (target.kind === "entity_ref") {
        if (!entities.has(target.key)) fail("missing_entity", target.key);
        materializedEntities.add(target.key);
      }
      if (target.kind === "occurrence_ref" && !nodes.has(target.key)) fail("missing_occurrence", target.key);
      if (target.kind === "content_ref" && !nodes.has(target.key)) fail("missing_content", target.key);
      if (target.kind === "bound_variable" && (nodes.get(target.quantifier) === undefined
        || nodes.get(target.quantifier)?.kind === "statement")) {
        fail("wrong_quantifier_kind", target.quantifier);
      }
    }
    if (node.kind === "reported" && node.reporter !== undefined && !entities.has(node.reporter.key)) {
      fail("missing_reporter", node.reporter.key);
    }
    if (node.kind === "reported" && node.reporter !== undefined) materializedEntities.add(node.reporter.key);
  }
  const domains = new Set<string>();
  const nativeKeys = new Set(nodes.keys());
  for (const row of content.domains ?? []) {
    meter.charge(1, 96, "table domain index");
    if (nativeKeys.has(row.key)) fail("duplicate_native_key", row.key);
    nativeKeys.add(row.key);
    domains.add(row.key);
    for (const member of [...row.members, ...row.exclusions]) {
      if (!entities.has(member.referent.key)) fail("missing_domain_entity", member.referent.key);
      materializedEntities.add(member.referent.key);
    }
  }
  const measurements = new Set<string>();
  for (const row of content.measurements ?? []) {
    meter.charge(1, 96, "table measurement index");
    if (nativeKeys.has(row.key)) fail("duplicate_native_key", row.key);
    nativeKeys.add(row.key);
    measurements.add(row.key);
    if (!entities.has(row.subject.key)) fail("missing_measurement_subject", row.subject.key);
    materializedEntities.add(row.subject.key);
  }
  for (const node of content.nodes) if (node.kind === "forall" && !domains.has(node.domain)) {
    fail("missing_quantifier_domain", node.domain);
  }
  for (const entity of content.entities) if (entity.semantic_key !== undefined && nativeKeys.has(entity.semantic_key)) {
    fail("duplicate_native_key", entity.semantic_key);
  }
  const occurrence = (key: string) => { if (!nodes.has(key)) fail("missing_occurrence", key); };
  for (const row of content.domains ?? []) {
    if (row.context !== null) occurrence(row.context);
    for (const member of row.members) {
      occurrence(member.evidence);
      for (const restriction of member.restrictions) {
        occurrence(restriction.restriction); occurrence(restriction.evidence);
      }
    }
    for (const exclusion of row.exclusions) occurrence(exclusion.evidence);
    if (row.closure.kind === "closed") occurrence(row.closure.evidence);
  }
  for (const row of content.measurements ?? []) {
    occurrence(row.owner);
    if (!domains.has(row.population)) fail("missing_measurement_population", row.population);
  }
  const queue: { key: string; root: string; depth: number }[] = [];
  for (const row of content.roots) {
    if (!nodes.has(row.expression.key)) fail("missing_root", row.expression.key);
    if (owner.has(row.expression.key)) fail("ambiguous_root_owner", row.expression.key);
    owner.set(row.expression.key, "@root");
    queue.push({ key: row.expression.key, root: row.expression.key, depth: 1 });
  }
  while (queue.length > 0) {
    const item = queue.pop()!;
    meter.charge(1, 128, "table ownership walk");
    if (item.depth > SOURCE_SEMANTIC_MAX_DEPTH + 1) fail("expression_depth_exceeded", item.key);
    if (root.has(item.key)) fail("cyclic_or_reused_content", item.key);
    root.set(item.key, item.root);
    for (const child of edges.get(item.key) ?? []) queue.push({ key: child, root: item.root, depth: item.depth + 1 });
  }
  if (root.size !== nodes.size) fail("disconnected_or_cyclic_content", String(nodes.size - root.size));
  for (const node of content.nodes) {
    for (const ref of references(node)) if (ref.kind === "content_reference") {
      if (!nodes.has(ref.key)) fail("missing_content_reuse", ref.key);
      if (owner.get(ref.key) !== node.key) fail("foreign_content_reference", ref.key);
    }
  }
  for (const gap of content.gaps) {
    for (const affected of gap.affected) {
      if (affected.kind === "occurrence_ref") {
        if (!nodes.has(affected.key)) fail("missing_gap_occurrence", affected.key);
      } else {
        const entity = entities.get(affected.key);
        if (entity === undefined) fail("missing_gap_entity", affected.key);
        if (entity.semantic_key === undefined) fail("gap_entity_requires_semantic_key", affected.key);
      }
    }
  }
  for (const row of content.entities) if (!materializedEntities.has(row.key)) fail("unused_entity_definition", row.key);
  return { nodes, entities };
}

/** Table syntax and ownership adapt into the shared internal lowering ledger. */
export function materializeSourceSemanticTableProposal(value: unknown,
  binding: Readonly<{ catalog: SourceReferenceCatalog; sha256: FieldContractSha256 }>,
  meter = new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 })) {
  meter.retain(value, "table proposal input");
  const proposal = SourceSemanticTableProposalSchema.parse(value);
  const violation = sourceSemanticProducerEnvelopeViolation("source", proposal.outcome.status, proposal.content !== undefined);
  if (violation !== undefined) fail(violation, proposal.outcome.status);
  const content = proposal.content;
  if (content === undefined) return compileSourceSemanticSelection(undefined, proposal.outcome, binding, meter);
  const { nodes, entities } = index(content, meter);
  const entity = (key: string): object => {
    const row = entities.get(key)!;
    if (row.form === "selection") return row.semantic_key === undefined ? row.selection : {
      kind: "entity", key: row.semantic_key, mentions: [row.selection]
    };
    return {
      kind: "entity", ...(row.semantic_key === undefined ? {} : { key: row.semantic_key }),
      ...(row.referent_kind === undefined ? {} : { referent_kind: row.referent_kind }), mentions: row.mentions
    };
  };
  const target = (row: TargetValue): object => {
    if (row.kind === "entity_ref") return entity(row.key);
    if (row.kind === "occurrence_ref") return { kind: "occurrence", key: row.key };
    if (row.kind === "content_ref") return expression(row.key);
    return row;
  };
  const operand = (row: OperandValue): object => row.kind === "content_ref" ? expression(row.key) : row;
  const expression = (key: string): object => {
    meter.charge(1, 256, "table node expansion");
    const row = nodes.get(key)!;
    if (row.kind === "statement") return { kind: row.kind, key: row.key, predicate: row.predicate,
      arguments: [...row.arguments, ...row.qualifications].map(arg => ({
        role: arg.role, target: target(arg.target), ...(arg.support === undefined ? {} : { support: arg.support })
      })) };
    if (row.kind === "conditional") return { kind: row.kind, key: row.key, support: row.support,
      antecedent: operand(row.antecedent), consequent: operand(row.consequent) };
    if (row.kind === "opaque") return { kind: row.kind, key: row.key, support: row.support,
      operands: row.operands.map(operand) };
    const base = { kind: row.kind, key: row.key, support: row.support, content: operand(row.content) };
    if (row.kind === "reported") return { ...base,
      ...(row.reporter === undefined ? {} : { reporter: entity(row.reporter.key) }) };
    if (row.kind === "forall") return { ...base, domain: row.domain,
      restriction: row.restriction === null ? null : operand(row.restriction) };
    return base;
  };
  const selection = { outcome: proposal.outcome,
    content: { roots: content.roots.map(row => ({ act: row.act, expression: expression(row.expression.key) })),
      ...(content.domains === undefined ? {} : { domains: content.domains.map(row => ({ ...row,
        members: row.members.map(member => ({ ...member, referent: entity(member.referent.key) })),
        exclusions: row.exclusions.map(exclusion => ({ ...exclusion, referent: entity(exclusion.referent.key) })) })) }),
      ...(content.measurements === undefined ? {} : { measurements: content.measurements.map(row => ({
        ...row, subject: entity(row.subject.key) })) }),
      gaps: content.gaps.map(row => ({ kind: row.kind, support: row.support,
        affected: row.affected.map(affected => affected.kind === "occurrence_ref" ? affected.key
          : entities.get(affected.key)!.semantic_key!),
        ...(row.description === undefined ? {} : { description: row.description }) })) } };
  meter.retain(selection, "table selection lowering");
  return compileSourceSemanticSelection(selection.content, selection.outcome, binding, meter);
}
