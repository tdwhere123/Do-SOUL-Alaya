import { z } from "zod";
import { resolveBenchDaemonConfigRoot } from "../../../harness/daemon/daemon-config-directory.js";

const ImportEffectsSchema = z.object({
  configDirectoryRoot: z.string().min(1), sqliteWriteQueue: z.literal("disabled"),
  embeddingStartupProbe: z.literal("omit"), gardenCompute: z.literal("disabled")
}).strict();
export type SourceRecordsImportEffects = Readonly<z.infer<typeof ImportEffectsSchema>>;

/** Shared explicit effect boundary for message imports and round publication.
 * It changes startup work, not dataset authority, source identity or content. */
export function resolveSourceRecordsImportEffects(input: SourceRecordsImportEffects | undefined) {
  if (input === undefined) return undefined;
  const parsed = ImportEffectsSchema.parse(input);
  return { ...parsed, configDirectoryRoot: resolveBenchDaemonConfigRoot(parsed.configDirectoryRoot) };
}
