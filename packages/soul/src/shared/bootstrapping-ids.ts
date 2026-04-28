export function buildBootstrappingPathId(workspaceId: string, templateId: string): string {
  return `path-bootstrap:${workspaceId}:${templateId}`;
}

export function buildBootstrappingRecordId(workspaceId: string): string {
  return `bootstrap-record:${workspaceId}`;
}
