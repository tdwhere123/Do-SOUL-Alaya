export {
  explodePackedWorkingCopy,
  workspaceSliceDbPath,
  type ExplodePackedWorkingCopyInput,
  type ExplodedWorkspaceSlices
} from "./explode.js";
export {
  digestWorkspaceSliceSnapshotIdentity,
  readValidWorkspaceSliceSnapshotDigest,
  sealFinalizedWorkspaceSlice,
  assertQuiescentMainDb,
  WORKSPACE_SLICE_EXPLODE_RECIPE_ID,
  WORKSPACE_SLICE_EXPLODE_RECIPE_VERSION,
  WORKSPACE_SLICE_SNAPSHOT_SIDECAR_FILENAME,
  WORKSPACE_SLICE_SQLITE_KIND
} from "./slice-snapshot.js";
export {
  installWorkspaceSlice,
  packedWorkingDbPath,
  preservePackedWorkingCopy,
  workingAlayaDbPath
} from "./install.js";
export { loadSliceIntoOpenDatabase } from "./load-open.js";
export {
  explodeRecallEvalWorkingCopyIfNeeded,
  installRecallEvalWorkspaceSlice
} from "./pager.js";
export {
  isWorkspaceSliceSkipped,
  PACKED_WORKING_DB_FILENAME,
  SKIP_WORKSPACE_SLICE_ENV,
  WORKSPACE_SLICE_DIRNAME
} from "./names.js";
export type { WorkspaceSliceProgress } from "./stream-copy.js";
