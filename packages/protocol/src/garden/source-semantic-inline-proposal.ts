import type { z } from "zod";
import type { SourceReferenceCatalog } from "../evidence/source-reference.js";
import type { FieldContractSha256 } from "../recall/field-contract/canonical-identity.js";
import { SourceSemanticResourceLedger } from "./source-semantic-resources.js";
import { SourceSemanticSelectionEntitySchema } from "./source-semantic-selection-lowering.js";
import { SourceSemanticInlineProposalSchema, SOURCE_SEMANTIC_TABLE_LIMIT,
  SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT } from "./source-semantic-table-shape.js";
import { materializeSourceSemanticTableProposal, SourceSemanticTableValidationError } from "./source-semantic-table-proposal.js";

type EntityUse = z.infer<typeof SourceSemanticSelectionEntitySchema>;
type Proposal = z.infer<typeof SourceSemanticInlineProposalSchema>;
type Content = NonNullable<Proposal["content"]>;
type EntityRow = Readonly<{ form: "entity"; key: string; semantic_key?: string;
  referent_kind?: EntityUse["referent_kind"]; mentions: EntityUse["mentions"] }>;

/** Reuse exact evidence rows, never normalize mentions or infer semantic identity. */
function entityRows(meter: SourceSemanticResourceLedger) {
  const rows: EntityRow[] = [], exact = new Map<string, string>(), identities = new Map<string, string>();
  const use = (entity: EntityUse) => {
    // Charge before the bounded tuple/key copies, including worst-case JSON escaping.
    meter.retain(entity, "inline constructor inspection");
    const stringUnits = (entity.key?.length ?? 0) + (entity.referent_kind?.length ?? 0)
      + entity.mentions.reduce((size, mention) => size + mention.text.length, 0);
    meter.charge(entity.mentions.length + 1, 256 + 24 * stringUnits + 128 * entity.mentions.length, "inline exact constructor index");
    const tuple = JSON.stringify([entity.key ?? null, entity.referent_kind ?? null,
      entity.mentions.map(row => [row.assertion_id, row.text, row.occurrence ?? null])]);
    let key = exact.get(tuple);
    if (key === undefined) {
      if (rows.length >= SOURCE_SEMANTIC_TABLE_LIMIT.entities) {
        throw new SourceSemanticTableValidationError("native_entity_capacity_exceeded", String(rows.length + 1));
      }
      meter.charge(1, 256, "inline entity row allocation");
      key = `u${rows.length}`;
      rows.push({ form: "entity", key, mentions: entity.mentions,
        ...(entity.key === undefined ? {} : { semantic_key: entity.key }),
        ...(entity.referent_kind === undefined ? {} : { referent_kind: entity.referent_kind }) });
      exact.set(tuple, key);
      if (entity.key !== undefined && !identities.has(entity.key)) identities.set(entity.key, key);
    }
    return { kind: "entity_ref" as const, key };
  };
  const gap = (identity: string) => {
    meter.charge(1, 64, "inline gap identity lookup");
    const key = identities.get(identity);
    if (key === undefined) throw new SourceSemanticTableValidationError("missing_gap_entity", identity);
    return { kind: "entity_ref" as const, key };
  };
  return { rows, use, gap };
}

function tableContent(content: Content, meter: SourceSemanticResourceLedger) {
  const entities = entityRows(meter);
  const target = (row: Content["nodes"][number] & { kind: "statement" }) => {
    const argument = (arg: (typeof row)["arguments"][number]) => {
      meter.charge(1, 128, "inline argument adaptation");
      return { ...arg, target: arg.target.kind === "entity" ? entities.use(arg.target) : arg.target };
    };
    return { ...row, arguments: row.arguments.map(argument), qualifications: row.qualifications.map(argument) };
  };
  const nodes = content.nodes.map(row => {
    meter.charge(1, 128, "inline occurrence adaptation");
    if (row.kind === "statement") return target(row);
    if (row.kind === "reported" && row.reporter !== undefined) return { ...row, reporter: entities.use(row.reporter) };
    return row;
  });
  const domains = content.domains?.map(row => {
    meter.charge(1, 128, "inline domain adaptation");
    return { ...row, members: row.members.map(member => {
      meter.charge(1, 128, "inline member adaptation");
      return { ...member, referent: entities.use(member.referent) };
    }), exclusions: row.exclusions.map(exclusion => {
      meter.charge(1, 128, "inline exclusion adaptation");
      return { ...exclusion, referent: entities.use(exclusion.referent) };
    }) };
  });
  const measurements = content.measurements?.map(row => {
    meter.charge(1, 128, "inline measurement adaptation");
    return { ...row, subject: entities.use(row.subject) };
  });
  const gaps = content.gaps.map(row => {
    meter.charge(1, 128, "inline gap adaptation");
    return { ...row, affected: row.affected.map(affected => affected.kind === "entity_ref"
      ? entities.gap(affected.key) : affected) };
  });
  return { ...content, nodes, entities: entities.rows, gaps,
    ...(domains === undefined ? {} : { domains }), ...(measurements === undefined ? {} : { measurements }) };
}

/** Authoritative parse followed by a metered presentation adapter to the existing semantic owner. */
export function materializeSourceSemanticInlineProposal(value: unknown,
  binding: Readonly<{ catalog: SourceReferenceCatalog; sha256: FieldContractSha256 }>,
  meter = new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 })) {
  meter.retain(value, "inline proposal input");
  const proposal = SourceSemanticInlineProposalSchema.parse(value);
  return materializeSourceSemanticTableProposal({ ...proposal, contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT,
    ...(proposal.content === undefined ? {} : { content: tableContent(proposal.content, meter) }) }, binding, meter);
}
