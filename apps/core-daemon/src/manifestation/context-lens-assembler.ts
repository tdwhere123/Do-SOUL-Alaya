import type { ConversationContextLensAssemblerPort } from "@do-soul/alaya-core";

export interface ManifestationContextLensAssemblerDependencies {
  readonly delegate: ConversationContextLensAssemblerPort;
}

export function createManifestationContextLensAssembler(
  deps: ManifestationContextLensAssemblerDependencies
): ConversationContextLensAssemblerPort {
  // Keep the daemon seam truthful until a real candidate/task-surface producer exists.
  return deps.delegate;
}
