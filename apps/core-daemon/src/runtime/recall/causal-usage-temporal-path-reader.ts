import {
  fieldContractSha256,
  projectCausalUsageOntoPaths
} from "@do-soul/alaya-core";
import type {
  FieldContractSha256,
  PathAnchorRef,
  PathRelation
} from "@do-soul/alaya-protocol";
import type { FieldCausalUsageRepo } from "@do-soul/alaya-storage";
import { causalUsageReceiptFromRow } from "../field/sqlite-causal-usage-port.js";
import type {
  RecallPathProjectionReadOptions,
  TemporalRecallPathProjectionReader
} from "./recall-path-readers.js";

export function createCausalUsageTemporalPathReader(input: Readonly<{
  readonly base: TemporalRecallPathProjectionReader;
  readonly usageRepo: FieldCausalUsageRepo;
  readonly sha256?: FieldContractSha256;
  readonly now?: () => string;
}>): TemporalRecallPathProjectionReader {
  const project = createProjector(input);
  return Object.freeze({
    findByWorkspace: async (
      workspaceId: string,
      options: RecallPathProjectionReadOptions = {}
    ) =>
      await project(workspaceId, options, input.base.findByWorkspace(workspaceId, options)),
    findByAnchors: async (
      workspaceId: string,
      anchors: readonly PathAnchorRef[],
      options: RecallPathProjectionReadOptions = {}
    ) =>
      await project(
        workspaceId,
        options,
        input.base.findByAnchors(workspaceId, anchors, options)
      ),
    findByTimeConcernWindowDigests: async (
      workspaceId: string,
      digests: readonly string[],
      options: RecallPathProjectionReadOptions = {}
    ) =>
      await project(
        workspaceId,
        options,
        input.base.findByTimeConcernWindowDigests(workspaceId, digests, options)
      )
  });
}

function createProjector(input: Readonly<{
  readonly usageRepo: FieldCausalUsageRepo;
  readonly sha256?: FieldContractSha256;
  readonly now?: () => string;
}>) {
  const sha256 = input.sha256 ?? fieldContractSha256;
  const now = input.now ?? (() => new Date().toISOString());
  return async (
    workspaceId: string,
    options: RecallPathProjectionReadOptions,
    pathsPromise: Promise<readonly Readonly<PathRelation>[]>
  ): Promise<readonly Readonly<PathRelation>[]> => {
    const paths = await pathsPromise;
    const asOf = options.asOf ?? now();
    const receipts = input.usageRepo.listByWorkspaceAtAsOf(workspaceId, asOf)
      .map((row) => causalUsageReceiptFromRow(row, sha256));
    return projectCausalUsageOntoPaths(paths, receipts, asOf);
  };
}
