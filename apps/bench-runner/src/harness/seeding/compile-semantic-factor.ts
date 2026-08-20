import { projectOfficialApiSemanticFactorGraph } from "@do-soul/alaya-soul";

const SEMANTIC_FACTOR_KEYS = [
  "semantic_factor_graph",
  "semantic_factor_graph_projection"
] as const;

export function omitCompileSemanticFactorFields(
  payload: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const next = { ...payload };
  for (const key of SEMANTIC_FACTOR_KEYS) delete next[key];
  return next;
}

export function compileSourceBoundSemanticFactorFields(
  payload: Readonly<Record<string, unknown>>,
  assertion: string | null
): ReturnType<typeof projectOfficialApiSemanticFactorGraph> {
  return projectOfficialApiSemanticFactorGraph(
    payload.semantic_factor_graph,
    assertion
  );
}
