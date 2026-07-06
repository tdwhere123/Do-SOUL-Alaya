export interface JanitorRetentionDecayPort {
  scanRetentionDecay(workspaceId: string): Promise<Readonly<{
    readonly updated_count: number;
    readonly manifestation_changes: number;
  }>>;
}

export async function runJanitorRetentionDecayScan(
  port: JanitorRetentionDecayPort | undefined,
  workspaceId: string
): Promise<string> {
  if (port === undefined) {
    return "[SKIPPED] retention_decay_scan: port not wired";
  }
  const result = await port.scanRetentionDecay(workspaceId);
  return `retention_decay_scan: updated ${result.updated_count} hot memories (${result.manifestation_changes} manifestation changes) in ${workspaceId}`;
}
