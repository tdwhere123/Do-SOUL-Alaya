export const PACKED_WORKING_DB_FILENAME = "packed.alaya.db";
export const WORKSPACE_SLICE_DIRNAME = "workspace-slices";
export const WORKSPACE_SLICE_DB_FILENAME = "alaya.db";
export const SKIP_WORKSPACE_SLICE_ENV = "ALAYA_RECALL_EVAL_SKIP_WORKSPACE_SLICE";
export const REQUIRE_SLICE_REUSE_ENV = "ALAYA_RECALL_EVAL_REQUIRE_SLICE_REUSE";

const SKIP_TRUTHY = new Set(["1", "true", "on", "yes"]);

export function isWorkspaceSliceSkipped(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return envFlagEnabled(env, SKIP_WORKSPACE_SLICE_ENV);
}

export function isSliceReuseRequired(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return envFlagEnabled(env, REQUIRE_SLICE_REUSE_ENV);
}

function envFlagEnabled(
  env: Readonly<Record<string, string | undefined>>,
  key: string
): boolean {
  const raw = env[key]?.trim().toLowerCase();
  return raw !== undefined && SKIP_TRUTHY.has(raw);
}

export function quoteIdent(name: string): string {
  return `"${name.replaceAll("\"", "\"\"")}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
