import { createHash } from "node:crypto";
import { compareCodeUnits } from "@do-soul/alaya-protocol";
import { z } from "zod";

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const LexicalLaneIdSchema = z.enum([
  "exact",
  "porter",
  "trigram",
  "object_key_porter",
  "object_key_trigram"
]);
const IndexKindSchema = z.enum([
  "memory_entries",
  "memory_content_fts_porter",
  "memory_content_fts",
  "memory_object_key_fts",
  "memory_object_key_fts_trigram"
]);
const INDEX_KIND = Object.freeze({
  exact: "memory_entries",
  porter: "memory_content_fts_porter",
  trigram: "memory_content_fts",
  object_key_porter: "memory_object_key_fts",
  object_key_trigram: "memory_object_key_fts_trigram"
} as const);
const ApplicabilitySchema = z.union([
  z.object({ applicable: z.literal(true) }).strict().readonly(),
  z.object({
    applicable: z.literal(false),
    reason: z.literal("no_tokens_routed")
  }).strict().readonly()
]);
const ScopeSchema = z.object({
  workspace_id: z.string().min(1),
  object_ids: z.array(z.string().min(1)).min(1).readonly().nullable(),
  tier: z.enum(["hot", "warm", "cold"]).nullable()
}).strict().readonly();

type Universe = Readonly<{
  readonly producer_id: "alaya.storage.lexicalLaneEvaluatedUniverse.v1";
  readonly lane_id: z.infer<typeof LexicalLaneIdSchema>;
  readonly index_kind: z.infer<typeof IndexKindSchema>;
  readonly tokens_routed: boolean;
  readonly applicability: z.infer<typeof ApplicabilitySchema>;
  readonly scope: z.infer<typeof ScopeSchema>;
  readonly candidate_keys: readonly string[];
  readonly count: number;
  readonly universe_digest: string;
}>;

export const LexicalLaneEvaluatedUniverseSchema = z.object({
  producer_id: z.literal("alaya.storage.lexicalLaneEvaluatedUniverse.v1"),
  lane_id: LexicalLaneIdSchema,
  index_kind: IndexKindSchema,
  tokens_routed: z.boolean(),
  applicability: ApplicabilitySchema,
  scope: ScopeSchema,
  candidate_keys: z.array(z.string().min(1)).readonly(),
  count: z.number().int().nonnegative(),
  universe_digest: DigestSchema
}).strict().superRefine(refineUniverse).readonly();

export function refineLaneUniverse(
  lane: {
    readonly lane_id: z.infer<typeof LexicalLaneIdSchema>;
    readonly rows?: readonly { readonly candidate_key: string }[];
    readonly evaluated_universe?: Universe;
  },
  context: z.RefinementCtx
): void {
  if (lane.evaluated_universe === undefined) return;
  if (lane.evaluated_universe.lane_id !== lane.lane_id) {
    context.addIssue({
      code: "custom",
      path: ["evaluated_universe", "lane_id"],
      message: "universe lane_id must match the parent lane"
    });
  }
  const keys = new Set(lane.evaluated_universe.candidate_keys);
  lane.rows?.forEach((row, index) => {
    if (!keys.has(row.candidate_key)) {
      context.addIssue({
        code: "custom",
        path: ["rows", index, "candidate_key"],
        message: "observed candidate_key is not in the applicable universe"
      });
    }
  });
}

export function refineReceiptUniverses(
  lanes: readonly {
    readonly lane_id?: z.infer<typeof LexicalLaneIdSchema>;
    readonly evaluated_universe?: Universe;
  }[],
  context: z.RefinementCtx
): void {
  const present = lanes
    .map((lane) => lane.evaluated_universe)
    .filter((universe): universe is Universe => universe !== undefined);
  if (present.length === 0) return;
  if (present.length !== lanes.length) {
    context.addIssue({
      code: "custom",
      path: ["lanes"],
      message: "lexical lane universe set is incomplete"
    });
    return;
  }
  refineSharedRequestAxes(present, context);
  refineEffectiveAppliedTiers(present, context);
}

export function refineUniversesMatchWorkspace(
  workspaceId: string | Readonly<{ readonly status: "unavailable" }>,
  lanes: readonly { readonly evaluated_universe?: Universe }[],
  context: z.RefinementCtx
): void {
  if (typeof workspaceId !== "string") return;
  lanes.forEach((lane, index) => {
    if (lane.evaluated_universe !== undefined &&
        lane.evaluated_universe.scope.workspace_id !== workspaceId) {
      context.addIssue({
        code: "custom",
        path: ["receipt", "lanes", index, "evaluated_universe", "scope", "workspace_id"],
        message: "universe workspace does not match sealed identity"
      });
    }
  });
}

function refineUniverse(universe: Universe, context: z.RefinementCtx): void {
  if (INDEX_KIND[universe.lane_id] !== universe.index_kind) {
    context.addIssue({
      code: "custom",
      path: ["index_kind"],
      message: "index_kind does not match lane_id"
    });
  }
  if (universe.tokens_routed !== universe.applicability.applicable) {
    context.addIssue({
      code: "custom",
      path: ["applicability"],
      message: "applicability does not match routed-token metadata"
    });
  }
  if (!universe.tokens_routed && universe.candidate_keys.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["candidate_keys"],
      message: "no_tokens_routed universe must be empty"
    });
  }
  if (universe.count !== universe.candidate_keys.length) {
    context.addIssue({
      code: "custom",
      path: ["count"],
      message: "count must equal candidate_keys length"
    });
  }
  if (!isSortedUnique(universe.candidate_keys)) {
    context.addIssue({
      code: "custom",
      path: ["candidate_keys"],
      message: "universe keys must be sorted unique"
    });
  }
  if (universe.scope.object_ids !== null && !isSortedUnique(universe.scope.object_ids)) {
    context.addIssue({
      code: "custom",
      path: ["scope", "object_ids"],
      message: "universe object_ids must be sorted unique"
    });
  }
  if (universe.universe_digest !== digestUniverse(universe)) {
    context.addIssue({
      code: "custom",
      path: ["universe_digest"],
      message: "lexical lane universe digest mismatch"
    });
  }
}

function isSortedUnique(keys: readonly string[]): boolean {
  for (let index = 1; index < keys.length; index += 1) {
    if (compareCodeUnits(keys[index - 1]!, keys[index]!) >= 0) return false;
  }
  return true;
}

function refineSharedRequestAxes(
  universes: readonly Universe[],
  context: z.RefinementCtx
): void {
  const first = universes[0]!;
  if (universes.some((universe) => universe.scope.workspace_id !== first.scope.workspace_id)) {
    context.addIssue({
      code: "custom",
      path: ["lanes"],
      message: "lexical lane universe workspace is inconsistent"
    });
  }
  if (universes.some((universe) =>
    JSON.stringify(universe.scope.object_ids) !== JSON.stringify(first.scope.object_ids)
  )) {
    context.addIssue({
      code: "custom",
      path: ["lanes"],
      message: "lexical lane universe object_ids are inconsistent"
    });
  }
}

function refineEffectiveAppliedTiers(
  universes: readonly Universe[],
  context: z.RefinementCtx
): void {
  const dualTiers = uniqueTiers(universes, false);
  const contentTiers = uniqueTiers(universes, true);
  if (dualTiers.size > 1 || contentTiers.size > 1) {
    context.addIssue({
      code: "custom",
      path: ["lanes"],
      message: "lexical lane universe applied tier is inconsistent"
    });
    return;
  }
  const contentTier = [...contentTiers][0];
  const dualTier = [...dualTiers][0];
  const objectIds = universes[0]!.scope.object_ids;
  if (objectIds !== null && contentTier !== undefined && contentTier !== null) {
    context.addIssue({
      code: "custom",
      path: ["lanes"],
      message: "content-fts universe must drop tier when object_ids are applied"
    });
  }
  if (objectIds === null && contentTier !== undefined && contentTier !== null &&
      dualTier !== undefined && contentTier !== dualTier) {
    context.addIssue({
      code: "custom",
      path: ["lanes"],
      message: "lexical lane universe applied tier is inconsistent"
    });
  }
}

function uniqueTiers(
  universes: readonly Universe[],
  contentFts: boolean
): ReadonlySet<Universe["scope"]["tier"]> {
  return new Set(universes
    .filter((universe) => (universe.lane_id === "porter" || universe.lane_id === "trigram") === contentFts)
    .map((universe) => universe.scope.tier));
}

function digestUniverse(universe: Universe): string {
  const { universe_digest: _digest, ...body } = universe;
  return `sha256:${createHash("sha256").update(JSON.stringify({
    producer_id: body.producer_id,
    lane_id: body.lane_id,
    index_kind: body.index_kind,
    tokens_routed: body.tokens_routed,
    applicability: body.applicability,
    scope: {
      workspace_id: body.scope.workspace_id,
      object_ids: body.scope.object_ids,
      tier: body.scope.tier
    },
    candidate_keys: body.candidate_keys,
    count: body.count
  }), "utf8").digest("hex")}`;
}
