import {
  PathAnchorRefSchema,
  PathRelationSchema,
  type PathAnchorRef,
  type PathLifecycleStatus,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import {
  DEFAULT_REPO_LIST_PAGE_LIMIT,
  parsePageLimit,
  parsePageOffset
} from "../shared/validators.js";
import type { PathRelationPageOptions } from "./path-relation-types.js";

export interface PathRelationRow {
  readonly path_id: string;
  readonly workspace_id: string;
  readonly anchors_json: string;
  readonly constitution_json: string;
  readonly effect_vector_json: string;
  readonly plasticity_state_json: string;
  readonly lifecycle_json: string;
  readonly legitimacy_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

type PathLifecycleWithStatus = PathRelation["lifecycle"] & {
  readonly status?: PathLifecycleStatus;
};

export const PARSED_ROW_CACHE_MAX = 50_000;
export const DEFAULT_PATH_RELATION_PAGE = Object.freeze({
  limit: DEFAULT_REPO_LIST_PAGE_LIMIT,
  offset: 0
});

export function parsePathRelation(value: PathRelation): Readonly<PathRelation> {
  try {
    return deepFreeze(PathRelationSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate path relation.", error);
  }
}

export function parsePathAnchorRef(value: PathAnchorRef): Readonly<PathAnchorRef> {
  try {
    return deepFreeze(PathAnchorRefSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate path anchor ref.", error);
  }
}

export function parsePathRelationPage(page: PathRelationPageOptions): Readonly<PathRelationPageOptions> {
  return Object.freeze({
    limit: parsePageLimit(page.limit, "path relation page limit"),
    offset: parsePageOffset(page.offset, "path relation page offset")
  });
}

export function parseParsedRowCacheMax(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate path relation parsed-row cache max.");
  }

  return value;
}

export function parsePathRelationRow(row: PathRelationRow): Readonly<PathRelation> {
  return parsePathRelation({
    path_id: row.path_id,
    workspace_id: row.workspace_id,
    anchors: parseJsonFieldWithSchema(row.anchors_json, "anchors", pathRelationFieldSchemas.anchors),
    constitution: parseJsonFieldWithSchema(
      row.constitution_json,
      "constitution",
      pathRelationFieldSchemas.constitution
    ),
    effect_vector: parseJsonFieldWithSchema(
      row.effect_vector_json,
      "effect_vector",
      pathRelationFieldSchemas.effect_vector
    ),
    plasticity_state: parseJsonFieldWithSchema(
      row.plasticity_state_json,
      "plasticity_state",
      pathRelationFieldSchemas.plasticity_state
    ),
    lifecycle: normalizeLifecycle(
      parseJsonFieldWithSchema(row.lifecycle_json, "lifecycle", pathRelationFieldSchemas.lifecycle)
    ),
    legitimacy: parseJsonFieldWithSchema(
      row.legitimacy_json,
      "legitimacy",
      pathRelationFieldSchemas.legitimacy
    ),
    created_at: row.created_at,
    updated_at: row.updated_at
  });
}

export function comparePathRelationOrder(left: Readonly<PathRelation>, right: Readonly<PathRelation>): number {
  if (left.created_at === right.created_at) {
    return left.path_id.localeCompare(right.path_id);
  }

  return left.created_at.localeCompare(right.created_at);
}

function normalizeLifecycle(lifecycle: PathRelation["lifecycle"]): PathRelation["lifecycle"] {
  const lifecycleWithStatus = lifecycle as PathLifecycleWithStatus;
  return {
    status: lifecycleWithStatus.status ?? "active",
    retirement_rule: lifecycle.retirement_rule,
    ...(lifecycle.cooldown_rule === undefined ? {} : { cooldown_rule: lifecycle.cooldown_rule }),
    ...(lifecycle.override_rule === undefined ? {} : { override_rule: lifecycle.override_rule })
  } as PathRelation["lifecycle"];
}

const pathRelationFieldSchemas = PathRelationSchema.unwrap().shape;

function parseJsonFieldWithSchema<T>(
  value: string,
  fieldName: string,
  schema: { parse(input: unknown): T }
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Failed to parse path relation ${fieldName}.`,
      error
    );
  }
  try {
    return schema.parse(parsed);
  } catch (error) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Invalid path relation ${fieldName}.`,
      error
    );
  }
}
