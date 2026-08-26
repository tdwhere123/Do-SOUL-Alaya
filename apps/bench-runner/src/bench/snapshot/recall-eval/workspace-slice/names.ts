export const PACKED_WORKING_DB_FILENAME = "packed.alaya.db";
export const WORKSPACE_SLICE_DIRNAME = "workspace-slices";
export const WORKSPACE_SLICE_DB_FILENAME = "alaya.db";
export const SKIP_WORKSPACE_SLICE_ENV = "ALAYA_RECALL_EVAL_SKIP_WORKSPACE_SLICE";

const SKIP_TRUTHY = new Set(["1", "true", "on", "yes"]);

export function isWorkspaceSliceSkipped(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  const raw = env[SKIP_WORKSPACE_SLICE_ENV]?.trim().toLowerCase();
  return raw !== undefined && SKIP_TRUTHY.has(raw);
}

export function quoteIdent(name: string): string {
  return `"${name.replaceAll("\"", "\"\"")}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
