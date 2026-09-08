export const NON_MEMORY_RECALL_PREVIEW_CHARS = 600;

// Source indexes retain the full capsule body; only the pseudo-memory transport
// is bounded so one non-memory object cannot consume the delivery packet.
export function createBoundedNonMemoryPreview(content: string): string {
  const trimmed = content.trim();
  return trimmed.length > NON_MEMORY_RECALL_PREVIEW_CHARS
    ? `${trimmed.slice(0, NON_MEMORY_RECALL_PREVIEW_CHARS).trimEnd()}…`
    : trimmed;
}
