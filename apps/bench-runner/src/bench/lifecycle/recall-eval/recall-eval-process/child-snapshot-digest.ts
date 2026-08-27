export function resolveWorkspaceSliceSnapshotDigest(
  slices: Readonly<{
    readonly sliceSnapshotDigests: Readonly<Record<string, string>>;
  }> | null,
  workspaceId: string
): string | undefined {
  if (slices === null) return undefined;
  return Object.hasOwn(slices.sliceSnapshotDigests, workspaceId)
    ? slices.sliceSnapshotDigests[workspaceId]
    : undefined;
}
