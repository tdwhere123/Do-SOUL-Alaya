import { createHash } from "node:crypto";
import {
  EvidenceCapsuleSchema,
  buildVerifiedUserAssertionReceiptPreimage,
  formatVerifiedUserAssertionSourceHash,
  type OpenSemanticFactorGraphProposal
} from "@do-soul/alaya-protocol";
import { vi } from "vitest";
import { RecallService, type RecallServiceDependencies } from "../../recall/recall-service.js";
import { captureRecallRequestTime } from
  "../../recall/runtime/query/recall-request-time.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { collectSupplementaryData } from "../../recall/supplements/supplementary-data.js";
import { createDependencies, createTaskSurface } from "./recall-service-test-fixtures.js";

interface CollectWithParams {
  readonly candidates: Parameters<typeof collectSupplementaryData>[0]["candidates"];
  readonly graphSupportPort: NonNullable<RecallServiceDependencies["graphSupportPort"]>;
  readonly warn?: RecallServiceDependencies["warn"];
  readonly evidenceSearchPort?: RecallServiceDependencies["evidenceSearchPort"];
  readonly routingKeyProjectionPort?: RecallServiceDependencies["routingKeyProjectionPort"];
  readonly entityExtractionPort?: RecallServiceDependencies["entityExtractionPort"];
  readonly queryFactFrameExtractionPort?:
    RecallServiceDependencies["queryFactFrameExtractionPort"];
  readonly openSemanticFactorExtractionPort?:
    RecallServiceDependencies["openSemanticFactorExtractionPort"];
  readonly queryText?: string | null;
  readonly budgetPenaltyPort?: RecallServiceDependencies["budgetPenaltyPort"];
  readonly pathPlasticityPort?: RecallServiceDependencies["pathPlasticityPort"];
  readonly runId?: string | null;
  readonly captureAnswerFeatures?: boolean;
  readonly coarseEvidenceFtsRanks?: Readonly<Record<string, number>>;
  readonly coarseEvidenceFtsRanksPerRef?: Readonly<Record<string, number>>;
  readonly referenceTime?: string;
  readonly degradationReasons?: Parameters<typeof collectSupplementaryData>[0]["degradationReasons"];
}

interface EvidenceCapsuleOverrides {
  readonly object_id?: string;
  readonly created_by?: string;
  readonly lifecycle_state?: "active" | "archived";
  readonly evidence_kind?: "conversation_excerpt" | "tool_output";
  readonly evidence_health_state?: "verified" | "questionable";
  readonly gist: string;
  readonly excerpt: string;
  readonly source_hash?: string | null;
  readonly artifact_ref?: string | null;
}

export async function collectWith(params: CollectWithParams) {
  const { dependencies } = createDependencies([]);
  const service = new RecallService(dependencies);
  const referenceTime = captureRecallRequestTime({
    explicitAsOf: params.referenceTime,
    now: dependencies.now
  }).effectiveAsOf;
  return await collectSupplementaryData({
    dependencies: {
      ...dependencies,
      graphSupportPort: params.graphSupportPort,
      evidenceSearchPort: params.evidenceSearchPort,
      routingKeyProjectionPort: params.routingKeyProjectionPort,
      entityExtractionPort: params.entityExtractionPort,
      queryFactFrameExtractionPort: params.queryFactFrameExtractionPort,
      openSemanticFactorExtractionPort: params.openSemanticFactorExtractionPort,
      ...(params.budgetPenaltyPort === undefined
        ? {}
        : { budgetPenaltyPort: params.budgetPenaltyPort }),
      ...(params.pathPlasticityPort === undefined
        ? {}
        : { pathPlasticityPort: params.pathPlasticityPort })
    },
    warn: params.warn ?? (() => undefined),
    candidates: params.candidates,
    routingKeyOwnerIds: params.candidates.map((candidate) => candidate.object_id),
    referenceTime,
    workspaceId: "workspace-1",
    runId: params.runId ?? null,
    queryText: params.queryText ?? null,
    queryProbes: compileRecallQueryProbes(params.queryText ?? null),
    policy: service.buildDefaultPolicy("chat", createTaskSurface().runtime_id),
    coarseFtsRanks: {},
    coarseTrigramFtsRanks: {},
    coarseSynthesisFtsRanks: {},
    coarseEvidenceFtsRanks: params.coarseEvidenceFtsRanks ?? {},
    coarseEvidenceFtsRanksPerRef: params.coarseEvidenceFtsRanksPerRef ?? {},
    coarseSourceProximityScores: {},
    coarseSourceCohortKeys: {},
    coarseStructuralScores: {},
    coarseGraphExpansionScores: {},
    coarseEntitySeedScores: {},
    coarsePathExpansionScores: {},
    coarsePathSuppressionScores: {},
    captureAnswerFeatures: params.captureAnswerFeatures ?? false,
    degradationReasons: params.degradationReasons
  });
}

export function emptyGraphSupportPort(): NonNullable<
  RecallServiceDependencies["graphSupportPort"]
> {
  return {
    countInboundSupports: vi.fn(async () => 0),
    countInboundEdgesWeighted: vi.fn(async () => 0)
  };
}

export function semanticProposal(
  sourceText: string,
  graph: Readonly<OpenSemanticFactorGraphProposal>
) {
  return {
    schema_version: 1 as const,
    producer_operator_id: "test_open_semantic_factor_v1",
    source_text: sourceText,
    graph
  };
}

export function binaryUseEvidenceSemanticGraph() {
  return binaryUseGraph("evidence", "used", "Atlas");
}

export function binaryUseQuerySemanticGraph() {
  return binaryUseGraph("query", "use", "What");
}

function binaryUseGraph(
  sourceKind: "evidence" | "query",
  predicateSurface: string,
  objectSurface: string
) {
  const query = sourceKind === "query";
  return {
    schema_version: 2 as const,
    source_kind: sourceKind,
    factors: [
      factor("actor", "I", 0, 0, "speaker"),
      factor("predicate", predicateSurface, 0, 0, "use"),
      ...(query ? [] : [factor("object", objectSurface, 0, 0, "atlas")])
    ],
    variables: query ? [{ variable_id: "answer", surface: objectSurface }] : [],
    result_variable_ids: query ? ["answer"] : [],
    propositions: [{
      proposition_id: "use-event",
      predicate_factor_id: "predicate",
      arguments: [
        semanticArgument(0, "factor", "actor"),
        semanticArgument(1, query ? "variable" : "factor", query ? "answer" : "object")
      ]
    }]
  };
}

export function evidenceSemanticGraph() {
  return semanticGraph("evidence", [
    factor("actor", "I", 0, 1, "speaker"),
    factor("predicate", "used", 2, 6, "use"),
    factor("object", "Atlas", 7, 12, "atlas"),
    factor("purpose", "research", 17, 25, "research")
  ], []);
}

export function querySemanticGraph() {
  return semanticGraph("query", [
    factor("actor", "I", 8, 9, "speaker"),
    factor("predicate", "use", 10, 13, "use"),
    factor("purpose", "research", 18, 26, "research")
  ], [{ variable_id: "answer", surface: "What" }]);
}

function semanticGraph(
  sourceKind: "evidence" | "query",
  factors: readonly ReturnType<typeof factor>[],
  variables: readonly Readonly<{
    readonly variable_id: string;
    readonly surface: string;
  }>[]
) {
  return {
    schema_version: 2 as const,
    source_kind: sourceKind,
    factors,
    variables,
    result_variable_ids: variables.length === 0 ? [] : ["answer"],
    propositions: [{
      proposition_id: "use-event",
      predicate_factor_id: "predicate",
      arguments: [
        semanticArgument(0, "factor", "actor"),
        semanticArgument(
          1,
          variables.length === 0 ? "factor" : "variable",
          variables.length === 0 ? "object" : "answer"
        ),
        semanticArgument(2, "factor", "purpose")
      ]
    }]
  };
}

function factor(
  factorId: string,
  surface: string,
  _start: number,
  _end: number,
  semanticIdentity: string
) {
  return {
    factor_id: factorId,
    surface,
    semantic_identity: semanticIdentity
  };
}

function semanticArgument(
  position: number,
  referenceKind: "factor" | "variable",
  referenceId: string,
  bindingIdentity = position === 0 ? "agent" : position === 1 ? "object" : "purpose"
) {
  return {
    position,
    binding_identity: bindingIdentity,
    reference_kind: referenceKind,
    reference_id: referenceId
  };
}

export function createEvidenceCapsule(overrides: Readonly<EvidenceCapsuleOverrides>) {
  const digest = createHash("sha256")
    .update(buildVerifiedUserAssertionReceiptPreimage(
      {
        workspace_id: "workspace-1",
        run_id: "run-1",
        surface_id: null,
        source_assertion: overrides.excerpt,
        source_corpus: overrides.gist
      }), "utf8")
    .digest("hex");
  return EvidenceCapsuleSchema.parse({
    object_id: overrides.object_id ?? "5c6b478a-3839-4a9b-833f-af22192c33c7",
    object_kind: "evidence_capsule",
    schema_version: 1,
    created_at: "2026-07-23T00:00:00.000Z",
    updated_at: "2026-07-23T00:00:00.000Z",
    created_by: overrides.created_by ?? "garden_compile",
    lifecycle_state: overrides.lifecycle_state ?? "active",
    evidence_kind: overrides.evidence_kind ?? "conversation_excerpt",
    semantic_anchor: {
      topic: "grounded User assertion",
      keywords: ["user", "assertion"],
      summary: "User supplied a grounded recall assertion."
    },
    event_anchor: null,
    physical_anchor: overrides.artifact_ref === undefined
      ? null
      : {
          file_path: null,
          line_range: null,
          symbol_name: null,
          artifact_ref: overrides.artifact_ref
        },
    evidence_health_state: overrides.evidence_health_state ?? "verified",
    gist: overrides.gist,
    excerpt: overrides.excerpt,
    source_hash: overrides.source_hash === undefined
      ? formatVerifiedUserAssertionSourceHash(digest)
      : overrides.source_hash,
    run_id: "run-1",
    workspace_id: "workspace-1",
    surface_id: null
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function evidenceId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
