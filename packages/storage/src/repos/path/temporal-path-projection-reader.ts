import {
  serializePathAnchorRef,
  type PathAnchorRef,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import type { RelationAssertionRepo } from "./relation-assertion-repo.js";

export interface TemporalProjectionReadOptions {
  readonly asOf?: string;
}

/**
 * Read-only adapter for temporal PathRelation projections. It deliberately
 * has no legacy-table fallback: selection decides which reader the runtime
 * receives, and this reader only exposes verified projection generations.
 */
export class SqliteTemporalPathProjectionReader {
  public constructor(private readonly relationAssertions: Pick<RelationAssertionRepo,
    "findActiveProjectionByWorkspace" | "findProjectionByWorkspaceAtAsOf">) {}

  public async findByWorkspace(
    workspaceId: string,
    options: TemporalProjectionReadOptions = {}
  ): Promise<readonly Readonly<PathRelation>[]> {
    return await this.readProjection(workspaceId, options.asOf);
  }

  public async findByAnchors(
    workspaceId: string,
    anchorRefs: readonly PathAnchorRef[],
    options: TemporalProjectionReadOptions = {}
  ): Promise<readonly Readonly<PathRelation>[]> {
    const anchorKeys = new Set(anchorRefs.map(serializePathAnchorRef));
    if (anchorKeys.size === 0) return Object.freeze([]);
    const paths = await this.readProjection(workspaceId, options.asOf);
    return Object.freeze(paths.filter((path) =>
      anchorKeys.has(serializePathAnchorRef(path.anchors.source_anchor)) ||
      anchorKeys.has(serializePathAnchorRef(path.anchors.target_anchor))
    ));
  }

  public async findByTimeConcernWindowDigests(
    workspaceId: string,
    windowDigests: readonly string[],
    options: TemporalProjectionReadOptions = {}
  ): Promise<readonly Readonly<PathRelation>[]> {
    const requested = new Set(windowDigests);
    if (requested.size === 0) return Object.freeze([]);
    const paths = await this.readProjection(workspaceId, options.asOf);
    return Object.freeze(paths.filter((path) =>
      [path.anchors.source_anchor, path.anchors.target_anchor].some((anchor) =>
        anchor.kind === "time_concern" && requested.has(anchor.window_digest)
      )
    ));
  }

  private async readProjection(
    workspaceId: string,
    asOf: string | undefined
  ): Promise<readonly Readonly<PathRelation>[]> {
    if (asOf === undefined) {
      return await this.relationAssertions.findActiveProjectionByWorkspace(workspaceId);
    }
    if (!Number.isFinite(Date.parse(asOf))) {
      throw new StorageError("VALIDATION_FAILED", "Temporal projection asOf must be a valid ISO datetime.");
    }
    const projection = await this.relationAssertions.findProjectionByWorkspaceAtAsOf(workspaceId, asOf);
    if (projection === null) {
      throw new StorageError(
        "CONFLICT",
        `No verified temporal projection exists for as-of ${asOf}; rebuild it before recall.`
      );
    }
    return projection;
  }
}
