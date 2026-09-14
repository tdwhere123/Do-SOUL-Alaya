import { serializePathAnchorRef, type PathAnchorRef, type PathRelation } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../sqlite/db.js";
import { StorageError } from "../../../shared/errors.js";
import { deepFreeze } from "@do-soul/alaya-protocol";
import { parseNonEmptyString } from "../../shared/validators.js";
import { findByAnchorsSql, findByBackingObjectIdsSql } from "../statements/path-relation-sql.js";
import type { PathRelationStatements } from "../statements/path-relation-statements.js";
import type { PathRelationListResult, PathRelationPageOptions } from "../path-relation-types.js";
import { parseRows } from "../../shared/parse-row.js";
import {
  DEFAULT_PATH_RELATION_PAGE,
  PATH_RELATION_ACTIVE_LIST_HARD_CAP,
  parsePathAnchorRef,
  parsePathRelationPage,
  PathRelationRowParser,
  type PathRelationRow
} from "../mappers/path-relation-rows.js";

export interface PathRelationQueryContext {
  readonly db: StorageDatabase;
  readonly statements: PathRelationStatements;
  readonly parseRow: (row: PathRelationRow) => Readonly<PathRelation>;
  readonly parseRows: (
    rows: readonly PathRelationRow[],
    options?: { readonly dedupe?: boolean }
  ) => readonly Readonly<PathRelation>[];
}

export async function findPathRelationById(
  ctx: PathRelationQueryContext,
  pathId: string
): Promise<Readonly<PathRelation> | null> {
  const parsedPathId = parseNonEmptyString(pathId, "path id");

  try {
    const row = ctx.statements.findByIdStatement.get(parsedPathId) as PathRelationRow | undefined;
    return row === undefined ? null : ctx.parseRow(row);
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError("QUERY_FAILED", `Failed to load path relation ${parsedPathId}.`, error);
  }
}

export async function findPathRelationsByWorkspace(
  ctx: PathRelationQueryContext,
  workspaceId: string
): Promise<readonly Readonly<PathRelation>[]> {
  return await findPathRelationsByWorkspacePage(ctx, workspaceId, DEFAULT_PATH_RELATION_PAGE);
}

export async function findAllPathRelationsByWorkspace(
  ctx: PathRelationQueryContext,
  workspaceId: string
): Promise<readonly Readonly<PathRelation>[]> {
  const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");

  try {
    const rows = parseRows(ctx.statements.findByWorkspaceStatement.all(parsedWorkspaceId), PathRelationRowParser, "path relation row");
    return ctx.parseRows(rows);
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError(
      "QUERY_FAILED",
      `Failed to list all path relations for workspace ${parsedWorkspaceId}.`,
      error
    );
  }
}

export async function findPathRelationsByWorkspacePage(
  ctx: PathRelationQueryContext,
  workspaceId: string,
  page: PathRelationPageOptions
): Promise<readonly Readonly<PathRelation>[]> {
  const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
  const parsedPage = parsePathRelationPage(page);

  try {
    const rows = parseRows(ctx.statements.findByWorkspacePagedStatement.all(
      parsedWorkspaceId,
      parsedPage.limit,
      parsedPage.offset
    ), PathRelationRowParser, "path relation row");
    return ctx.parseRows(rows);
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError(
      "QUERY_FAILED",
      `Failed to list paged path relations for workspace ${parsedWorkspaceId}.`,
      error
    );
  }
}

export async function findPathRelationsByAnchor(
  ctx: PathRelationQueryContext,
  workspaceId: string,
  anchorRef: PathAnchorRef
): Promise<readonly Readonly<PathRelation>[]> {
  const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
  const parsedAnchor = parsePathAnchorRef(anchorRef);
  const anchorKey = serializePathAnchorRef(parsedAnchor);

  try {
    const sourceRows = parseRows(ctx.statements.findBySourceAnchorStatement.all(parsedWorkspaceId, anchorKey), PathRelationRowParser, "path relation row");
    const targetRows = parseRows(ctx.statements.findByTargetAnchorStatement.all(parsedWorkspaceId, anchorKey), PathRelationRowParser, "path relation row");
    return ctx.parseRows([...sourceRows, ...targetRows], { dedupe: true });
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError("QUERY_FAILED", "Failed to list path relations by anchor.", error);
  }
}

export async function findPathRelationsByTargetAnchor(
  ctx: PathRelationQueryContext,
  workspaceId: string,
  anchorRef: PathAnchorRef
): Promise<readonly Readonly<PathRelation>[]> {
  const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
  const parsedAnchor = parsePathAnchorRef(anchorRef);
  const anchorKey = serializePathAnchorRef(parsedAnchor);

  try {
    const rows = parseRows(ctx.statements.findByTargetAnchorStatement.all(parsedWorkspaceId, anchorKey), PathRelationRowParser, "path relation row");
    return ctx.parseRows(rows);
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError("QUERY_FAILED", "Failed to list path relations by target anchor.", error);
  }
}

export async function findPathRelationsByAnchors(
  ctx: PathRelationQueryContext,
  workspaceId: string,
  anchorRefs: readonly PathAnchorRef[]
): Promise<readonly Readonly<PathRelation>[]> {
  const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
  const anchorKeys = [...new Set(anchorRefs.map((anchorRef) => serializePathAnchorRef(parsePathAnchorRef(anchorRef))))];

  if (anchorKeys.length === 0) {
    return deepFreeze([]);
  }

  const statement = ctx.db.connection.prepare(findByAnchorsSql(anchorKeys.length));

  try {
    const rows = parseRows(statement.all(parsedWorkspaceId, ...anchorKeys, ...anchorKeys),
      PathRelationRowParser,
      "path relation row"
    );
    return ctx.parseRows(rows, { dedupe: true });
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError("QUERY_FAILED", "Failed to list path relations by anchors.", error);
  }
}

export async function findPathRelationsByBackingObjectId(
  ctx: PathRelationQueryContext,
  workspaceId: string,
  objectId: string
): Promise<readonly Readonly<PathRelation>[]> {
  const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
  const parsedObjectId = parseNonEmptyString(objectId, "object id");

  try {
    const rows = parseRows(ctx.statements.findByBackingObjectIdStatement.all(
      parsedWorkspaceId,
      parsedObjectId,
      parsedWorkspaceId,
      parsedObjectId
    ), PathRelationRowParser, "path relation row");
    return ctx.parseRows(rows, { dedupe: true });
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError(
      "QUERY_FAILED",
      `Failed to list path relations by backing object id for workspace ${parsedWorkspaceId}.`,
      error
    );
  }
}

const BACKING_OBJECT_ID_BATCH_SIZE = 400;

export async function findPathRelationsByBackingObjectIds(
  ctx: PathRelationQueryContext,
  workspaceId: string,
  objectIds: readonly string[]
): Promise<readonly Readonly<PathRelation>[]> {
  const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
  const parsedObjectIds = [...new Set(
    objectIds.map((objectId) => parseNonEmptyString(objectId, "object id"))
  )];
  if (parsedObjectIds.length === 0) {
    return deepFreeze([]);
  }

  try {
    const rows: PathRelationRow[] = [];
    for (let offset = 0; offset < parsedObjectIds.length; offset += BACKING_OBJECT_ID_BATCH_SIZE) {
      const batch = parsedObjectIds.slice(offset, offset + BACKING_OBJECT_ID_BATCH_SIZE);
      const statement = ctx.db.connection.prepare(findByBackingObjectIdsSql(batch.length));
      rows.push(
        ...parseRows(
          statement.all(parsedWorkspaceId, ...batch, parsedWorkspaceId, ...batch),
          PathRelationRowParser,
          "path relation row"
        )
      );
    }
    return ctx.parseRows(rows, { dedupe: true });
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    throw new StorageError(
      "QUERY_FAILED",
      `Failed to list path relations by backing object ids for workspace ${parsedWorkspaceId}.`,
      error
    );
  }
}

export async function findActivePathRelations(
  ctx: PathRelationQueryContext,
  workspaceId: string
): Promise<readonly Readonly<PathRelation>[]> {
  return await findActivePathRelationPage(ctx, workspaceId, DEFAULT_PATH_RELATION_PAGE);
}

export async function findAllActivePathRelations(
  ctx: PathRelationQueryContext,
  workspaceId: string,
  hardCap = PATH_RELATION_ACTIVE_LIST_HARD_CAP
): Promise<Readonly<PathRelationListResult>> {
  const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
  const cap = parseActiveListHardCap(hardCap);

  try {
    const rows = parseRows(ctx.statements.findActivePagedStatement.all(
      parsedWorkspaceId,
      cap + 1,
      0
    ), PathRelationRowParser, "path relation row");
    return capPathRelationList(ctx.parseRows(rows), cap);
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError(
      "QUERY_FAILED",
      `Failed to list all active path relations for workspace ${parsedWorkspaceId}.`,
      error
    );
  }
}

export function capPathRelationList<T>(
  rows: readonly T[],
  cap: number
): Readonly<{ readonly relations: readonly T[]; readonly truncated: boolean }> {
  const truncated = rows.length > cap;
  return {
    relations: truncated ? rows.slice(0, cap) : rows,
    truncated
  };
}

function parseActiveListHardCap(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate path relation active-list cap.");
  }
  return value;
}

export async function findActivePathRelationPage(
  ctx: PathRelationQueryContext,
  workspaceId: string,
  page: PathRelationPageOptions
): Promise<readonly Readonly<PathRelation>[]> {
  const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
  const parsedPage = parsePathRelationPage(page);

  try {
    const rows = parseRows(ctx.statements.findActivePagedStatement.all(
      parsedWorkspaceId,
      parsedPage.limit,
      parsedPage.offset
    ), PathRelationRowParser, "path relation row");
    return ctx.parseRows(rows);
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError(
      "QUERY_FAILED",
      `Failed to list paged active path relations for workspace ${parsedWorkspaceId}.`,
      error
    );
  }
}

export async function findDormantPathRelations(
  ctx: PathRelationQueryContext,
  workspaceId: string,
  olderThanIso: string
): Promise<readonly Readonly<PathRelation>[]> {
  return await findDormantPathRelationPage(ctx, workspaceId, olderThanIso, DEFAULT_PATH_RELATION_PAGE);
}

export async function findAllDormantPathRelations(
  ctx: PathRelationQueryContext,
  workspaceId: string,
  olderThanIso: string
): Promise<readonly Readonly<PathRelation>[]> {
  const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
  const parsedOlderThanIso = parseNonEmptyString(olderThanIso, "older-than timestamp");

  try {
    const rows = parseRows(ctx.statements.findDormantStatement.all(
      parsedWorkspaceId,
      parsedOlderThanIso
    ), PathRelationRowParser, "path relation row");
    return ctx.parseRows(rows);
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError(
      "QUERY_FAILED",
      `Failed to list all dormant path relations for workspace ${parsedWorkspaceId}.`,
      error
    );
  }
}

export async function findDormantPathRelationPage(
  ctx: PathRelationQueryContext,
  workspaceId: string,
  olderThanIso: string,
  page: PathRelationPageOptions
): Promise<readonly Readonly<PathRelation>[]> {
  const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
  const parsedOlderThanIso = parseNonEmptyString(olderThanIso, "older-than timestamp");
  const parsedPage = parsePathRelationPage(page);

  try {
    const rows = parseRows(ctx.statements.findDormantPagedStatement.all(
      parsedWorkspaceId,
      parsedOlderThanIso,
      parsedPage.limit,
      parsedPage.offset
    ), PathRelationRowParser, "path relation row");
    return ctx.parseRows(rows);
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }

    throw new StorageError(
      "QUERY_FAILED",
      `Failed to list paged dormant path relations for workspace ${parsedWorkspaceId}.`,
      error
    );
  }
}
