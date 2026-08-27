import type { StorageTier } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../sqlite/db.js";
import {
  ACTIVE_MEMORY_ENTRIES_FILTER_SQL,
  ACTIVE_MEMORY_FILTER_SQL,
  memoryTierFilterSql
} from "../recall/active-memory-filter-sql.js";
import {
  buildObjectIdFilterSql,
  type KeywordLaneTokens,
  type ObjectIdFilterColumn
} from "../keyword-search.js";
import { buildWorkspaceFtsScopeMatch } from "../../shared/fts-lane-routing.js";
import { objectIdFilterColumnForFtsTable } from "../search-workflows.js";
import { objectIdFilterColumnForKeyTable } from "./object-key-fts.js";
import {
  LEXICAL_LANE_INDEX_KIND,
  contentFtsLaneDropsRequestedTier,
  laneTokensWereRouted,
  sealLexicalLaneEvaluatedUniverse,
  sealLexicalLaneUniverseScope,
  type LexicalLaneEvaluatedUniverseWitness,
  type LexicalLaneIndexKind,
  type LexicalLaneUniverseMap,
  type LexicalRawRankLaneId
} from "./lexical-lane-universe.js";

export type { LexicalLaneUniverseMap };

const LANE_IDS: readonly LexicalRawRankLaneId[] = Object.freeze([
  "exact",
  "porter",
  "object_key_porter",
  "trigram",
  "object_key_trigram"
]);

interface UniverseQueryHost {
  activeConnection(): StorageDatabase["connection"];
}

export function enumerateLexicalLaneUniverses(
  this: UniverseQueryHost,
  input: Readonly<{
    readonly workspaceId: string;
    readonly objectIds?: readonly string[];
    readonly tier?: StorageTier;
    readonly tokens: KeywordLaneTokens;
  }>
): LexicalLaneUniverseMap {
  return Object.freeze(Object.fromEntries(LANE_IDS.map((laneId) => [
    laneId,
    enumerateOneLane.call(this, laneId, input)
  ]))) as LexicalLaneUniverseMap;
}

function enumerateOneLane(
  this: UniverseQueryHost,
  laneId: LexicalRawRankLaneId,
  input: Readonly<{
    readonly workspaceId: string;
    readonly objectIds?: readonly string[];
    readonly tier?: StorageTier;
    readonly tokens: KeywordLaneTokens;
  }>
): LexicalLaneEvaluatedUniverseWitness {
  const tokensRouted = laneTokensWereRouted(input.tokens, laneId);
  return sealLexicalLaneEvaluatedUniverse({
    laneId,
    tokensRouted,
    scope: sealLexicalLaneUniverseScope({ ...input, laneId }),
    candidateKeys: tokensRouted
      ? queryLaneUniverseKeys.call(this, laneId, input)
      : []
  });
}

function queryLaneUniverseKeys(
  this: UniverseQueryHost,
  laneId: LexicalRawRankLaneId,
  input: Readonly<{
    readonly workspaceId: string;
    readonly objectIds?: readonly string[];
    readonly tier?: StorageTier;
  }>
): readonly string[] {
  const applied = appliedLaneQueryScope(laneId, input);
  if (laneId === "exact") return queryExactUniverseKeys.call(this, applied);
  return queryIndexedUniverseKeys.call(this, LEXICAL_LANE_INDEX_KIND[laneId], laneId, applied);
}

function appliedLaneQueryScope(
  laneId: LexicalRawRankLaneId,
  input: Readonly<{
    readonly workspaceId: string;
    readonly objectIds?: readonly string[];
    readonly tier?: StorageTier;
  }>
): Readonly<{
  readonly workspaceId: string;
  readonly objectIds?: readonly string[];
  readonly tier?: StorageTier;
}> {
  if (!contentFtsLaneDropsRequestedTier(laneId, input.objectIds)) return input;
  return { workspaceId: input.workspaceId, objectIds: input.objectIds };
}

function queryExactUniverseKeys(
  this: UniverseQueryHost,
  input: Readonly<{
    readonly workspaceId: string;
    readonly objectIds?: readonly string[];
    readonly tier?: StorageTier;
  }>
): readonly string[] {
  const objectIdFilter = buildObjectIdFilterSql(input.objectIds);
  const tierSql = memoryTierFilterSql(input.tier);
  return selectObjectIds(this.activeConnection(), `
    SELECT object_id
    FROM memory_entries
    WHERE workspace_id = ?
    ${ACTIVE_MEMORY_FILTER_SQL}
    ${objectIdFilter.sql}
    ${tierSql}
    ORDER BY object_id ASC
  `, [
    input.workspaceId,
    ...objectIdFilter.params,
    ...(input.tier === undefined ? [] : [input.tier])
  ]);
}

function queryIndexedUniverseKeys(
  this: UniverseQueryHost,
  table: LexicalLaneIndexKind,
  laneId: Exclude<LexicalRawRankLaneId, "exact">,
  input: Readonly<{
    readonly workspaceId: string;
    readonly objectIds?: readonly string[];
    readonly tier?: StorageTier;
  }>
): readonly string[] {
  const ownerColumn = ownerColumnForLane(laneId);
  const objectIdFilter = buildObjectIdFilterSql(
    input.objectIds,
    objectIdFilterColumnForLane(laneId)
  );
  const tierSql = memoryTierFilterSql(input.tier, "memory_entries.storage_tier");
  return selectObjectIds(this.activeConnection(), `
    SELECT DISTINCT ${table}.${ownerColumn} AS object_id
    FROM ${table}
    JOIN memory_entries ON memory_entries.object_id = ${table}.${ownerColumn}
    WHERE ${table}.workspace_id = ?
      AND ${table} MATCH ?
      ${ACTIVE_MEMORY_ENTRIES_FILTER_SQL}
      ${objectIdFilter.sql}
      ${tierSql}
    ORDER BY ${table}.${ownerColumn} ASC
  `, [
    input.workspaceId,
    buildWorkspaceFtsScopeMatch(input.workspaceId),
    ...objectIdFilter.params,
    ...(input.tier === undefined ? [] : [input.tier])
  ]);
}

function objectIdFilterColumnForLane(
  laneId: Exclude<LexicalRawRankLaneId, "exact">
): ObjectIdFilterColumn {
  if (laneId === "porter") return objectIdFilterColumnForFtsTable("memory_content_fts_porter");
  if (laneId === "trigram") return objectIdFilterColumnForFtsTable("memory_content_fts");
  return objectIdFilterColumnForKeyTable(
    laneId === "object_key_trigram"
      ? "memory_object_key_fts_trigram"
      : "memory_object_key_fts"
  );
}

function ownerColumnForLane(laneId: Exclude<LexicalRawRankLaneId, "exact">): "object_id" | "owner_id" {
  return laneId === "porter" || laneId === "trigram" ? "object_id" : "owner_id";
}

function selectObjectIds(
  connection: StorageDatabase["connection"],
  sql: string,
  params: readonly unknown[]
): readonly string[] {
  return Object.freeze(
    (connection.prepare(sql).all(...params) as readonly { readonly object_id: string }[])
      .map((row) => row.object_id)
  );
}
