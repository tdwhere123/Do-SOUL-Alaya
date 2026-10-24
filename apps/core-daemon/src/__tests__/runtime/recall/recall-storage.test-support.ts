import { createHash } from "node:crypto";
import { SourceIndexBackfill, SourceIndexLifecycle, fieldContractSha256 } from "@do-soul/alaya-core";
import { prepareIndexedRecallProjection, SqliteSourceIndexRepository } from "@do-soul/alaya-storage";
import type { SourceIndexConfiguration } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { SIMULATED_CONFIGURATION } from "./source-semantic-index-acquisition.test-support.js";
import { REAL_SQLITE_TEST_WORKSPACE_ID as WS } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";

/** Live recall pins the indexed-recall projection the daemon prepares at startup.
 * Fixtures that open a database for recall must own the same schema, not a second one.
 */
export async function openRecallStorage(...input: Parameters<typeof createRecallRealStorage>) {
  const storage = await createRecallRealStorage(...input);
  prepareIndexedRecallProjection(storage.database);
  return storage;
}

const INDEX_BUDGET = { work: 100_000, native_bytes: 16 * 1024 * 1024 };
const digest = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

/** Native library membership comes from one accepted source-index generation.
 * Explicit simulation only: authored axes, no provider, model or recorded cache.
 */
export async function publishIndexedGeneration(database: StorageDatabase,
  bodies: readonly Readonly<{ text: string; vector?: readonly number[] }>[],
  configuration: SourceIndexConfiguration = SIMULATED_CONFIGURATION, workspace = WS): Promise<number> {
  const repository = new SqliteSourceIndexRepository(database, fieldContractSha256);
  const lifecycle = new SourceIndexLifecycle(repository, fieldContractSha256);
  const selection = lifecycle.select(workspace, configuration), generation = lifecycle.begin(selection);
  let captured = lifecycle.capture(workspace, generation.generation_id, 128, INDEX_BUDGET);
  while (!captured.generation.enumeration_complete) captured = lifecycle.capture(workspace, generation.generation_id, 128, INDEX_BUDGET);
  const axisByText = new Map(bodies.map(row => [row.text, row.vector ?? [0, 1, 0]]));
  const binding = { status: "ready" as const, profile: selection.configuration.profile, profile_id: selection.profile_id,
    embedInputs: async (inputs: readonly Readonly<{ input_id: string; text: string }>[]) => inputs.map(input => ({
      status: "embedded" as const, input_id: input.input_id, input_digest: digest(input.text),
      vector: new Float32Array(axisByText.get(input.text) ?? [0, 1, 0]), token_count: 2, truncated: false as const })) };
  for (const target of repository.listTargets(workspace, generation.generation_id, null, 128)) {
    await new SourceIndexBackfill(lifecycle).step({ selection, generation_id: generation.generation_id,
      root_key: target.root_key, binding, budget: { ...INDEX_BUDGET,
        model_inputs: 128, input_bytes: 1_000_000, max_body_bytes: 1_000_000 },
      deadline_ms: Date.now() + 60_000, signal: new AbortController().signal });
  }
  if (lifecycle.publish(workspace, generation.generation_id).status !== "accepted") {
    throw new Error("fixture source index generation was not accepted");
  }
  return repository.listTargets(workspace, generation.generation_id, null, 128).length;
}
