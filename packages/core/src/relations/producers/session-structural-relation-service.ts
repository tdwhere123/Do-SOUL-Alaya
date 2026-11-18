import { createHash } from "node:crypto";
import {
  RelationFormationSourceKind,
  canonicalJson,
  compareUtcInstants
} from "@do-soul/alaya-protocol";
import { stableStringify } from "../../shared/stable-stringify.js";
import type { RelationAssertionService } from "../relation-assertions/relation-assertion-service.js";
import type { RelationAssertionAdmissionRequest } from "../relation-assertions/relation-assertion-service-types.js";
import { sha256RelationAssertionValue } from "../relation-assertions/relation-projection-builder.js";

const OPERATOR_ID = "session_structural_relation_v1";
const OPERATOR_SHA256 = sha256RelationAssertionValue(OPERATOR_ID);
const MAX_STATEMENT_EDGES_PER_SOURCE = 2;

export type StructuralSourceEventRecord = Readonly<{
  readonly event_id: string;
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly workspace_id: string;
  readonly run_id: string | null;
  readonly caused_by: string | null;
  readonly revision: number;
  readonly payload_json: unknown;
  readonly created_at: string;
}>;

export type RoundStructuralNode = Readonly<{
  readonly workspaceId: string;
  readonly containerKey: string;
  readonly roundIndex: number;
  readonly recordId: string;
  readonly observedAt: string;
  readonly sourceOccurredAt: string;
  readonly sourceEvent: StructuralSourceEventRecord;
}>;

export type StatementStructuralNode = Readonly<{
  readonly workspaceId: string;
  readonly artifactId: string;
  readonly recordId: string;
  readonly targetObjectId: string;
  readonly content: string;
  readonly observedAt: string;
  readonly sourceOccurredAt: string;
  readonly sourceEvent: StructuralSourceEventRecord;
}>;

export type SessionStructuralMaterializeInput = Readonly<{
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly causedBy: string;
  readonly rounds: readonly RoundStructuralNode[];
  readonly statements: readonly StatementStructuralNode[];
  readonly admittedAt?: string;
}>;

export type SessionStructuralMaterializeResult = Readonly<{
  readonly roundsScanned: number;
  readonly statementsScanned: number;
  readonly assertionsAttempted: number;
  readonly assertionsAdmitted: number;
  readonly assertionsAlreadyPresent: number;
  readonly assertionsFailed: number;
  readonly projectionRefreshed: boolean;
}>;

type AssertionCandidate = Readonly<{
  readonly score: number;
  readonly request: RelationAssertionAdmissionRequest;
}>;

type TokenizedStatement = Readonly<{
  readonly node: StatementStructuralNode;
  readonly normalized: string;
  readonly tokens: ReadonlySet<string>;
  readonly numbers: ReadonlySet<string>;
}>;

type StructuralEvidenceSide = Readonly<{
  readonly recordId: string;
  readonly sourceOccurredAt: string;
  readonly sourceEvent: StructuralSourceEventRecord;
}>;

export class SessionStructuralRelationService {
  public constructor(
    private readonly deps: Readonly<{
      readonly assertionService: Pick<
        RelationAssertionService,
        "admitDeferredProjection" | "refreshProjection"
      >;
      readonly warn?: (message: string, meta: Record<string, unknown>) => void;
    }>
  ) {}

  public async materialize(
    input: SessionStructuralMaterializeInput
  ): Promise<SessionStructuralMaterializeResult> {
    const roundRequests = buildSessionRoundRequests(input);
    const statementRequests = buildStatementRequests(input);
    const requests = [...roundRequests, ...statementRequests];
    let admitted = 0;
    let alreadyPresent = 0;
    let failed = 0;
    for (const request of requests) {
      try {
        const result = await this.deps.assertionService.admitDeferredProjection(request);
        if (result.status === "admitted") admitted += 1;
        else alreadyPresent += 1;
      } catch (error) {
        failed += 1;
        this.deps.warn?.("session structural relation admission skipped", {
          workspace_id: input.workspaceId,
          relation_kind: request.relationKind,
          source_id: request.anchors.source_anchor.kind === "object" ? request.anchors.source_anchor.object_id : undefined,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    let projectionRefreshed = false;
    if (admitted > 0) {
      await this.deps.assertionService.refreshProjection();
      projectionRefreshed = true;
    }
    return {
      roundsScanned: input.rounds.length,
      statementsScanned: input.statements.length,
      assertionsAttempted: requests.length,
      assertionsAdmitted: admitted,
      assertionsAlreadyPresent: alreadyPresent,
      assertionsFailed: failed,
      projectionRefreshed
    };
  }
}

export function buildSessionRoundRequests(
  input: Pick<
    SessionStructuralMaterializeInput,
    "workspaceId" | "runId" | "causedBy" | "rounds" | "admittedAt"
  >
): readonly RelationAssertionAdmissionRequest[] {
  const byContainer = new Map<string, RoundStructuralNode[]>();
  for (const round of input.rounds) {
    if (round.workspaceId !== input.workspaceId) continue;
    const list = byContainer.get(round.containerKey) ?? [];
    list.push(round);
    byContainer.set(round.containerKey, list);
  }
  const requests: RelationAssertionAdmissionRequest[] = [];
  for (const [containerKey, list] of byContainer) {
    list.sort((left, right) => left.roundIndex - right.roundIndex);
    for (let index = 0; index + 1 < list.length; index += 1) {
      const prev = list[index]!;
      const next = list[index + 1]!;
      if (next.roundIndex !== prev.roundIndex + 1 || prev.recordId === next.recordId) continue;
      const validFrom = maxInstant(prev.observedAt, next.observedAt);
      const baseMeta = {
        workspaceId: input.workspaceId,
        runId: input.runId,
        causedBy: input.causedBy,
        admittedAt: input.admittedAt,
        validFrom,
        left: prev,
        right: next,
        parameters: { container_key: containerKey, prev_round: prev.roundIndex, next_round: next.roundIndex }
      };
      requests.push(
        buildStructuralRequest({ ...baseMeta, relationKind: "next_round_in_session", sourceObjectId: prev.recordId, targetObjectId: next.recordId }),
        buildStructuralRequest({ ...baseMeta, relationKind: "prev_round_in_session", sourceObjectId: next.recordId, targetObjectId: prev.recordId })
      );
    }
  }
  return requests;
}

export function buildStatementRequests(
  input: Pick<
    SessionStructuralMaterializeInput,
    "workspaceId" | "runId" | "causedBy" | "statements" | "admittedAt"
  >
): readonly RelationAssertionAdmissionRequest[] {
  const tokenized = input.statements
    .filter((statement) => statement.workspaceId === input.workspaceId)
    .map(tokenizeStatement)
    .filter((entry) => entry.tokens.size >= 3);
  if (tokenized.length < 2) return [];
  const candidatePairs = collectCandidatePairs(tokenized);
  const bySourceAndKind = new Map<string, AssertionCandidate[]>();
  for (const [leftIndex, rightIndex] of candidatePairs) {
    const candidate = classifyStatementPair(input, tokenized[leftIndex]!, tokenized[rightIndex]!);
    if (candidate === null) continue;
    const src = candidate.request.anchors.source_anchor;
    const key = `${src.kind === "object" ? src.object_id : ""}\u0000${candidate.request.relationKind}`;
    const list = bySourceAndKind.get(key) ?? [];
    list.push(candidate);
    bySourceAndKind.set(key, list);
  }
  const requests: RelationAssertionAdmissionRequest[] = [];
  for (const list of bySourceAndKind.values()) {
    list.sort((left, right) => right.score - left.score);
    for (const entry of list.slice(0, MAX_STATEMENT_EDGES_PER_SOURCE)) {
      requests.push(entry.request);
    }
  }
  return requests;
}

function classifyStatementPair(
  input: Pick<SessionStructuralMaterializeInput, "workspaceId" | "runId" | "causedBy" | "admittedAt">,
  left: TokenizedStatement,
  right: TokenizedStatement
): AssertionCandidate | null {
  if (left.node.recordId === right.node.recordId || left.node.targetObjectId === right.node.targetObjectId) {
    return null;
  }
  const [older, newer] = orderPair(left, right);
  const overlap = countIntersection(older.tokens, newer.tokens);
  if (overlap < 3) return null;
  const union = older.tokens.size + newer.tokens.size - overlap;
  const jaccard = union === 0 ? 0 : overlap / union;
  const sameNums = setsEqual(older.numbers, newer.numbers);
  const exactMatch = older.normalized === newer.normalized && older.normalized.length > 0;
  let relationKind: "restates" | "supersedes" | null = null;
  if (exactMatch || (jaccard >= 0.72 && overlap >= 4 && sameNums)) {
    relationKind = "restates";
  } else if (
    compareUtcInstants(older.node.observedAt, newer.node.observedAt) === -1 &&
    ((jaccard >= 0.5 && overlap >= 4) ||
      (jaccard >= 0.42 && older.numbers.size > 0 && newer.numbers.size > 0 && !sameNums))
  ) {
    relationKind = "supersedes";
  }
  if (relationKind === null) return null;
  const request = buildStructuralRequest({
    workspaceId: input.workspaceId,
    runId: input.runId,
    causedBy: input.causedBy,
    admittedAt: input.admittedAt,
    relationKind,
    sourceObjectId: newer.node.targetObjectId,
    targetObjectId: older.node.targetObjectId,
    validFrom: newer.node.observedAt,
    left: older.node,
    right: newer.node,
    parameters: { jaccard: Number(jaccard.toFixed(4)), overlap, same_numbers: sameNums }
  });
  return { score: jaccard * 100 + overlap, request };
}

function buildStructuralRequest(input: Readonly<{
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly causedBy: string;
  readonly admittedAt?: string;
  readonly relationKind: string;
  readonly sourceObjectId: string;
  readonly targetObjectId: string;
  readonly validFrom: string;
  readonly left: StructuralEvidenceSide;
  readonly right: StructuralEvidenceSide;
  readonly parameters: Readonly<Record<string, unknown>>;
}>): RelationAssertionAdmissionRequest {
  const receipts = deduplicateReceipts([toReceipt(input.left), toReceipt(input.right)]);
  const observations = deduplicateObservations([input.left.sourceEvent, input.right.sourceEvent]);
  const decision = {
    relation_kind: input.relationKind,
    source_object_id: input.sourceObjectId,
    target_object_id: input.targetObjectId
  };
  return {
    workspaceId: input.workspaceId,
    runId: input.runId,
    causedBy: input.causedBy,
    ...(input.admittedAt === undefined ? {} : { admittedAt: input.admittedAt }),
    evidenceReceipts: receipts,
    formationReceipt: {
      operator_id: OPERATOR_ID,
      operator_sha256: OPERATOR_SHA256,
      parameters: input.parameters,
      parameter_sha256: sha256RelationAssertionValue(stableStringify(input.parameters)),
      source_observations: observations,
      decision,
      decision_sha256: sha256RelationAssertionValue(stableStringify(decision))
    },
    anchors: {
      source_anchor: { kind: "object", object_id: input.sourceObjectId },
      target_anchor: { kind: "object", object_id: input.targetObjectId }
    },
    relationKind: input.relationKind,
    validity: { kind: "open", valid_from: input.validFrom }
  };
}

function tokenizeStatement(node: StatementStructuralNode): TokenizedStatement {
  const normalized = node.content.normalize("NFKC").toLowerCase().trim();
  const rawTokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens = new Set<string>();
  const numbers = new Set<string>();
  for (const token of rawTokens) {
    if (token.length >= 2 || /\p{N}/u.test(token)) tokens.add(token);
    if (/\p{N}/u.test(token)) numbers.add(token);
  }
  return { node, normalized, tokens, numbers };
}

function collectCandidatePairs(items: readonly TokenizedStatement[]): readonly (readonly [number, number])[] {
  const postings = new Map<string, number[]>();
  const maxDf = Math.max(4, Math.floor(items.length * 0.25));
  for (let index = 0; index < items.length; index += 1) {
    for (const token of items[index]!.tokens) {
      const list = postings.get(token) ?? [];
      list.push(index);
      postings.set(token, list);
    }
  }
  const sharedCount = new Map<string, number>();
  for (const list of postings.values()) {
    if (list.length < 2 || list.length > maxDf) continue;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const key = `${list[i]!}:${list[j]!}`;
        sharedCount.set(key, (sharedCount.get(key) ?? 0) + 1);
      }
    }
  }
  const pairs: [number, number][] = [];
  for (const [key, count] of sharedCount) {
    if (count < 2) continue;
    const [left, right] = key.split(":").map(Number);
    pairs.push([left!, right!]);
  }
  return pairs;
}

function orderPair(left: TokenizedStatement, right: TokenizedStatement): [TokenizedStatement, TokenizedStatement] {
  const cmp = compareUtcInstants(left.node.observedAt, right.node.observedAt);
  if (cmp === 1 || (cmp === 0 && left.node.artifactId > right.node.artifactId)) {
    return [right, left];
  }
  return [left, right];
}

function toReceipt(side: StructuralEvidenceSide) {
  return {
    evidence_id: side.recordId,
    source_event_anchor: {
      event_type: side.sourceEvent.event_type,
      event_id: side.sourceEvent.event_id,
      occurred_at: side.sourceOccurredAt
    }
  };
}

function deduplicateReceipts(list: readonly ReturnType<typeof toReceipt>[]) {
  const byId = new Map<string, ReturnType<typeof toReceipt>>();
  for (const item of list) byId.set(item.evidence_id, item);
  return [...byId.values()].sort((a, b) => a.evidence_id.localeCompare(b.evidence_id));
}

function deduplicateObservations(events: readonly StructuralSourceEventRecord[]) {
  const byId = new Map<string, StructuralSourceEventRecord>();
  for (const event of events) byId.set(event.event_id, event);
  return [...byId.values()]
    .sort((a, b) => a.event_id.localeCompare(b.event_id))
    .map((event) => ({
      source_kind: RelationFormationSourceKind.EVENT_LOG_ENTRY,
      source_id: event.event_id,
      source_sha256: digestEventSource(event)
    }));
}

function digestEventSource(event: StructuralSourceEventRecord): string {
  return createHash("sha256")
    .update(canonicalJson({
      event_id: event.event_id,
      event_type: event.event_type,
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      workspace_id: event.workspace_id,
      run_id: event.run_id,
      caused_by: event.caused_by,
      revision: event.revision,
      payload_json: event.payload_json,
      created_at: event.created_at
    }), "utf8")
    .digest("hex");
}

function maxInstant(left: string, right: string): string {
  return compareUtcInstants(left, right) === 1 ? left : right;
}

function countIntersection(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  let count = 0;
  for (const value of smaller) if (larger.has(value)) count += 1;
  return count;
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}
