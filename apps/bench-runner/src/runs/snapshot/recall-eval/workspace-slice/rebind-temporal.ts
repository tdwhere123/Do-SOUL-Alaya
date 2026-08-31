import type { CopyConnection } from "./stream-copy.js";

export function rebindTemporalProjectionIdentity(dest: CopyConnection): void {
  const generations = dest.prepare(
    "SELECT generation FROM temporal_projection_generations"
  ).all() as ReadonlyArray<{ readonly generation: string }>;
  const countStatement = dest.prepare(
    "SELECT COUNT(*) AS n FROM relation_path_projections WHERE generation = ?"
  );
  const updateGeneration = dest.prepare(
    "UPDATE temporal_projection_generations SET projection_count = ? WHERE generation = ?"
  );
  for (const row of generations) {
    const counted = countStatement.get(row.generation) as { readonly n: number };
    updateGeneration.run(counted.n, row.generation);
  }
  dest.prepare(`
    UPDATE temporal_schema_state
    SET projection_count = (
      SELECT projection_count
      FROM temporal_projection_generations
      WHERE generation = temporal_schema_state.active_projection_generation
    )
    WHERE state_id = 1
      AND active_projection_generation IS NOT NULL
  `).run();
}
