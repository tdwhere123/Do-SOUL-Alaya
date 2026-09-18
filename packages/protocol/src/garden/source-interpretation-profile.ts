import { z } from "zod";
import { AlayaError } from "../shared/alaya-error.js";
import { canonicalJson } from "../recall/selection/capture/canonical-json.js";
import { type FieldContractSha256 } from "../recall/field-contract/canonical-identity.js";
import type { QueryProgram } from "../recall/conditional-field/query.js";
import type { SourceInterpretationPacket } from "./source-interpretation-packet.js";

export const SOURCE_INTERPRETATION_SCOPE_OPERATORS = ["not", "possible", "reported", "conditional", "opaque"] as const;

// Even six-byte JSON escapes leave the encoded relation key below the existing 1024-character query limit.
export const SourceInterpretationSymbolSchema = z.string().min(1).max(64);
const SymbolDefinition = z.object({ symbol: SourceInterpretationSymbolSchema, meaning: z.string().min(1).max(1024) }).strict().readonly();
const PredicateDefinition = SymbolDefinition.unwrap().extend({
  governing_roles: z.array(SourceInterpretationSymbolSchema).max(64).readonly()
}).strict().readonly();

/** A caller-selected vocabulary, not an ontology or a certificate of extraction fidelity. */
export const SourceInterpretationProfileSchema = z.object({
  contract: z.literal("source-interpretation-profile-v1"),
  description: z.string().min(1).max(4096),
  predicates: z.array(PredicateDefinition).min(1).max(128).readonly(),
  roles: z.array(SymbolDefinition).min(1).max(64).readonly()
}).strict().superRefine((profile, context) => {
  for (const definitions of [profile.predicates, profile.roles]) {
    if (new Set(definitions.map((row) => row.symbol)).size !== definitions.length) {
      context.addIssue({ code: "custom", message: "profile symbols must be unique within their domain" });
    }
  }
  const roles = new Set(profile.roles.map((row) => row.symbol));
  for (const predicate of profile.predicates) {
    if (new Set(predicate.governing_roles).size !== predicate.governing_roles.length ||
        predicate.governing_roles.some((role) => !roles.has(role))) {
      context.addIssue({ code: "custom", message: "governing roles must identify unique profile roles" });
    }
  }
}).readonly();

export type SourceInterpretationProfile = z.infer<typeof SourceInterpretationProfileSchema>;

export function sourceInterpretationProfileIdentity(profile: SourceInterpretationProfile, sha256: FieldContractSha256): string {
  return `sha256:${sha256(canonicalJson(SourceInterpretationProfileSchema.parse(profile)))}`;
}

export function assertSourceInterpretationPacketProfile(packet: SourceInterpretationPacket,
  profile: SourceInterpretationProfile, sha256: FieldContractSha256): void {
  if (packet.profile_id !== sourceInterpretationProfileIdentity(profile, sha256)) {
    throw new AlayaError("CONFLICT", "interpretation profile identity mismatch");
  }
  const predicates = new Set(profile.predicates.map((row) => row.symbol));
  const roles = new Set(profile.roles.map((row) => row.symbol));
  for (const proposition of packet.propositions) {
    if (!predicates.has(proposition.predicate)) throw new AlayaError("VALIDATION", "unknown interpretation predicate symbol");
    for (const arg of proposition.arguments) {
      if (!roles.has(arg.role)) throw new AlayaError("VALIDATION", "unknown interpretation role symbol");
    }
  }
  for (const operator of packet.operators) {
    for (const operand of operator.operands) {
      if (!roles.has(operand.role)) throw new AlayaError("VALIDATION", "unknown interpretation scope role symbol");
    }
  }
  assertPacketScope(packet, profile);
}

/** Only declared governing edges establish scope. Ordinary references may form cycles. */
function assertPacketScope(packet: SourceInterpretationPacket, profile: SourceInterpretationProfile): void {
  const definitions = new Map(profile.predicates.map((row) => [row.symbol, new Set(row.governing_roles)]));
  const children = new Map<string, readonly string[]>([
    ...packet.propositions.map((row) => [row.id, row.arguments.filter((arg) => definitions.get(row.predicate)!.has(arg.role)).map((arg) => arg.target)] as const),
    ...packet.operators.map((row) => [row.id, row.operands.map((arg) => arg.target)] as const)
  ]);
  const roots = new Set(packet.roots);
  const active = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string): void => {
    if (active.has(id)) throw new AlayaError("CONFLICT", "cyclic proposition scope");
    if (visited.has(id)) return;
    active.add(id);
    for (const target of children.get(id) ?? []) {
      if (roots.has(target)) throw new AlayaError("CONFLICT", "governed propositions cannot also be asserted roots");
      walk(target);
    }
    active.delete(id); visited.add(id);
  };
  for (const id of children.keys()) walk(id);
}

export function assertSourceInterpretationQueryProfile(program: QueryProgram, profile: SourceInterpretationProfile): void {
  const predicates = new Set(profile.predicates.map((row) => row.symbol));
  const roles = new Set(profile.roles.map((row) => row.symbol));
  const walk = (node: QueryProgram): void => {
    if (node.kind === "relation") {
      let key: unknown;
      try { key = JSON.parse(node.relation_kind); } catch {
        throw new AlayaError("VALIDATION", "query relation is outside interpretation profile");
      }
      if (!Array.isArray(key) || key.length !== 3 || key[0] !== "source-interpretation-v2" || typeof key[2] !== "string") {
        throw new AlayaError("VALIDATION", "query relation is outside interpretation profile");
      }
      const allowed = key[1] === "predicate" || key[1] === "asserted" ? predicates :
        key[1] === "role" || key[1] === "inverse_role" ? roles :
        key[1] === "operator" ? new Set<string>(SOURCE_INTERPRETATION_SCOPE_OPERATORS) : new Set();
      if (!allowed.has(key[2])) throw new AlayaError("VALIDATION", "unknown interpretation query symbol");
    } else if (node.kind === "sequence") node.steps.forEach(walk);
    else if (node.kind === "alternative") node.options.forEach(walk);
    else if (node.kind === "hyperedge") node.premises.forEach(walk);
    else if (node.kind === "closure" || node.kind === "repeat") walk(node.body);
  };
  walk(program);
}

export function sourceInterpretationRelationKey(kind: "predicate" | "asserted" | "role" | "inverse_role" | "operator", symbol: string): string {
  return JSON.stringify(["source-interpretation-v2", kind, SourceInterpretationSymbolSchema.parse(symbol)]);
}
