import {
  inspectSnapshotGraphPreflight,
  type SnapshotGraphPreflight
} from
  "./snapshot-graph-preflight.js";

export function assertSnapshotAnswersWithFormation(
  dbPath: string,
  expectedWorkspaceIds?: readonly string[]
): Readonly<SnapshotGraphPreflight> {
  const preflight = inspectSnapshotGraphPreflight(dbPath);
  if (preflight.eligibleCount < 1) {
    throw new Error(
      "snapshot writer requires at least one eligible answers_with relation"
    );
  }
  if (expectedWorkspaceIds !== undefined) {
    assertExpectedWorkspaceCoverage(preflight, expectedWorkspaceIds);
  }
  return preflight;
}

function assertExpectedWorkspaceCoverage(
  preflight: Readonly<SnapshotGraphPreflight>,
  expectedWorkspaceIds: readonly string[]
): void {
  const expected = [...new Set(expectedWorkspaceIds)].sort();
  const actual = [...preflight.eligibleWorkspaceIds];
  if (expected.length !== actual.length ||
      expected.some((workspaceId, index) => workspaceId !== actual[index])) {
    throw new Error(
      "snapshot answers_with formation coverage mismatch: " +
      `eligible_workspaces=${actual.length} expected_workspaces=${expected.length}`
    );
  }
}
