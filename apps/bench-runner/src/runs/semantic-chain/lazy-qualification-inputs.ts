import { dirname, join } from "node:path";
import { z } from "zod";
import { Digest } from "./bind-lazy.js";
import { readChainArtifactPayloadForInventory, retainedArtifactPathField } from "./contract.js";
import { semanticChainReplayInputPaths } from "./replay.js";
import { retainedSemanticChainCacheInputPaths } from "./inputs.js";

/** Known lazy-stage inputs remain protected even when later member evidence is unavailable. */
export function lazyQualificationInputPaths(root: string): readonly string[] {
  const snapshot = join(root, "final-library.sqlite");
  return [join(root, "window.json"), join(root, "final.json"), join(root, "first-exposure.json"),
    join(root, "first-exposure.reserved.json"), snapshot, `${snapshot}.publication.json`];
}

/** Inventory retained path references without admitting an executable member or losing known static inputs. */
export function lazyQualificationRetainedInputPaths(root: string): readonly string[] {
  const paths = [...lazyQualificationInputPaths(root)];
  const window = readChainArtifactPayloadForInventory(join(root, "window.json"));
  const initialRoot = retainedArtifactPathField(window, "config", "initial_chain_root");
  if (initialRoot !== undefined) paths.push(initialRoot, join(initialRoot, "prepare.json"),
    ...retainedSemanticChainCacheInputPaths(initialRoot));
  const windowQueryKey = retainedArtifactPathField(window, "query_key");
  const final = readChainArtifactPayloadForInventory(join(root, "final.json"));
  for (const key of ["final_snapshot_path", "publication_report_path"] as const) {
    const path = retainedArtifactPathField(final, key);
    if (path !== undefined) paths.push(path);
  }
  const finalRoot = retainedArtifactPathField(final, "final_chain_root");
  if (finalRoot !== undefined) paths.push(finalRoot, join(finalRoot, "prepare.json"),
    ...retainedSemanticChainCacheInputPaths(finalRoot));
  for (const name of ["first-exposure.json", "first-exposure.reserved.json"]) {
    const exposure = readChainArtifactPayloadForInventory(join(root, name));
    const replayPath = retainedArtifactPathField(exposure, "replay_path");
    if (replayPath === undefined) continue;
    const queryKeys = new Set<string>();
    if (Digest.safeParse(windowQueryKey).success) queryKeys.add(windowQueryKey!);
    const replayRoot = dirname(replayPath);
    paths.push(...retainedSemanticChainCacheInputPaths(replayRoot));
    const plan = z.object({ queries: z.array(z.unknown()) }).passthrough().safeParse(
      readChainArtifactPayloadForInventory(join(replayRoot, "prepare.json")));
    const replay = z.object({ rows: z.array(z.unknown()) }).passthrough().safeParse(
      readChainArtifactPayloadForInventory(replayPath));
    for (const row of [...(plan.success ? plan.data.queries : []), ...(replay.success ? replay.data.rows : [])]) {
      const key = retainedArtifactPathField(row, "query_key");
      if (Digest.safeParse(key).success) queryKeys.add(key!);
    }
    paths.push(...semanticChainReplayInputPaths(replayRoot, replayPath, [...queryKeys]));
  }
  return paths;
}
