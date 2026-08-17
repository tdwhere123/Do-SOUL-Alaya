import type {
  KeywordSearchFieldResult,
  KeywordSearchResult,
  RecallServiceDependencies,
  RecallServiceEvidenceSearchPort,
  RecallServiceMemoryRepoPort,
  RecallServiceSynthesisSearchPort
} from "../../../recall/runtime/recall-service-types.js";
import { RecallService } from "../../../recall/recall-service.js";
import { createSeededTestOnlyInMemoryFieldQuerySession } from
  "../../../recall/runtime/query/field-query-session.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";

export function createFieldBackedRecallService(
  dependencies: Readonly<RecallServiceDependencies>
): RecallService {
  return new RecallService(withKeywordFieldFixturePorts(dependencies));
}

export function withKeywordFieldFixturePorts(
  dependencies: Readonly<RecallServiceDependencies>
): RecallServiceDependencies {
  return {
    ...dependencies,
    testOnlyAllowInMemoryFieldQuerySession: true,
    fieldQuerySession: dependencies.fieldQuerySession ??
      createSeededTestOnlyInMemoryFieldQuerySession(fieldContractSha256, "workspace-1"),
    memoryRepo: withMemoryFieldFixture(dependencies.memoryRepo),
    evidenceSearchPort: dependencies.evidenceSearchPort === undefined
      ? undefined
      : withEvidenceFieldFixture(dependencies.evidenceSearchPort),
    synthesisSearchPort: dependencies.synthesisSearchPort === undefined
      ? undefined
      : withSynthesisFieldFixture(dependencies.synthesisSearchPort)
  };
}

function withMemoryFieldFixture(
  repo: Readonly<RecallServiceMemoryRepoPort>
): RecallServiceMemoryRepoPort {
  return {
    ...repo,
    searchByKeywordField: repo.searchByKeywordField ??
      (hasMemoryKeywordFixture(repo)
        ? async (workspaceId, queryText, limit, scope = {}) => keywordFieldResult(
          (await runMemoryKeywordFixture(repo, workspaceId, queryText, limit, scope))
            .slice(0, limit)
        )
        : undefined),
    searchByAnchorField: repo.searchByAnchorField ??
      (hasMemoryAnchorFixture(repo)
        ? async (workspaceId, anchors, optional, limit, scope = {}) => keywordFieldResult(
          (await runMemoryAnchorFixture(
            repo, workspaceId, anchors, optional, limit, scope
          )).slice(0, limit)
        )
        : undefined)
  };
}

function hasMemoryKeywordFixture(repo: Readonly<RecallServiceMemoryRepoPort>): boolean {
  return repo.searchByKeyword !== undefined ||
    repo.searchByKeywordWithinTier !== undefined ||
    repo.searchByKeywordWithinObjectIds !== undefined;
}

function hasMemoryAnchorFixture(repo: Readonly<RecallServiceMemoryRepoPort>): boolean {
  return repo.searchByAnchorWithinTier !== undefined ||
    repo.searchByAnchorWithinObjectIds !== undefined;
}

async function runMemoryKeywordFixture(
  repo: Readonly<RecallServiceMemoryRepoPort>,
  workspaceId: string,
  queryText: string,
  limit: number,
  scope: NonNullable<Parameters<NonNullable<RecallServiceMemoryRepoPort["searchByKeywordField"]>>[3]>
): Promise<readonly KeywordSearchResult[]> {
  if (scope.tier !== undefined && repo.searchByKeywordWithinTier !== undefined) {
    return await repo.searchByKeywordWithinTier(workspaceId, queryText, limit, scope.tier);
  }
  if (scope.objectIds !== undefined && repo.searchByKeywordWithinObjectIds !== undefined) {
    return await repo.searchByKeywordWithinObjectIds(
      workspaceId, queryText, limit, scope.objectIds
    );
  }
  return await repo.searchByKeyword?.(workspaceId, queryText, limit) ?? [];
}

async function runMemoryAnchorFixture(
  repo: Readonly<RecallServiceMemoryRepoPort>,
  workspaceId: string,
  anchors: readonly string[],
  optional: readonly string[],
  limit: number,
  scope: NonNullable<Parameters<NonNullable<RecallServiceMemoryRepoPort["searchByAnchorField"]>>[4]>
): Promise<readonly KeywordSearchResult[]> {
  if (scope.tier !== undefined && repo.searchByAnchorWithinTier !== undefined) {
    return await repo.searchByAnchorWithinTier(
      workspaceId, anchors, optional, limit, scope.tier
    );
  }
  if (scope.objectIds !== undefined && repo.searchByAnchorWithinObjectIds !== undefined) {
    return await repo.searchByAnchorWithinObjectIds(
      workspaceId, anchors, optional, limit, scope.objectIds
    );
  }
  return [];
}

function withEvidenceFieldFixture(
  port: Readonly<RecallServiceEvidenceSearchPort>
): RecallServiceEvidenceSearchPort {
  return {
    ...port,
    searchByKeywordField: port.searchByKeywordField ??
      fieldSearchFromScalar(port.searchByKeyword.bind(port))
  };
}

function withSynthesisFieldFixture(
  port: Readonly<RecallServiceSynthesisSearchPort>
): RecallServiceSynthesisSearchPort {
  return {
    ...port,
    searchByKeywordField: port.searchByKeywordField ??
      fieldSearchFromScalar(port.searchByKeyword.bind(port))
  };
}

export function keywordFieldResult(
  matches: readonly Readonly<KeywordSearchResult>[],
  lane: "exact" | "porter" | "trigram" = "porter"
): Readonly<KeywordSearchFieldResult> {
  const frozenMatches = Object.freeze(matches.map((match) => Object.freeze({ ...match })));
  return Object.freeze({
    matches: frozenMatches,
    lanes: Object.freeze((["exact", "porter", "trigram"] as const).map((candidateLane) =>
      candidateLane === lane
        ? Object.freeze({
          lane,
          status: "complete" as const,
          depth: frozenMatches.length,
          observations: Object.freeze(frozenMatches.map((match, index) =>
            Object.freeze({
              ...match,
              rank: index + 1,
              source_id: fixtureSourceId(match)
            })
          )),
          unseen_upper_bound: 0
        })
        : emptyLane(candidateLane)
    ))
  });
}

export function fieldSearchFromScalar<
  Args extends readonly unknown[]
>(
  search: (...args: Args) => Promise<readonly Readonly<KeywordSearchResult>[]>,
  lane: "exact" | "porter" | "trigram" = "porter"
): (...args: Args) => Promise<Readonly<KeywordSearchFieldResult>> {
  return async (...args) => {
    const matches = await search(...args);
    const limit = args[2];
    return keywordFieldResult(
      typeof limit === "number" && Number.isInteger(limit) && limit >= 0
        ? matches.slice(0, limit)
        : matches,
      lane
    );
  };
}

export function keywordSearchMethods<
  Args extends readonly unknown[]
>(
  search: (...args: Args) => Promise<readonly Readonly<KeywordSearchResult>[]>,
  lane: "exact" | "porter" | "trigram" = "porter"
) {
  return Object.freeze({
    searchByKeyword: search,
    searchByKeywordField: fieldSearchFromScalar(search, lane)
  });
}

function fixtureSourceId(match: Readonly<KeywordSearchResult>): string {
  const projection = match.matched_projection;
  return projection === undefined
    ? `fixture:${match.object_id}`
    : `fixture:${match.object_id}:${projection.projection_kind}:${projection.projection_id}`;
}

function emptyLane(lane: "exact" | "porter" | "trigram") {
  return Object.freeze({
    lane,
    status: "ineligible" as const,
    depth: 0,
    observations: Object.freeze([]),
    unseen_upper_bound: null
  });
}
