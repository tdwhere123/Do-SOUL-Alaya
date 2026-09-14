// Content-hash format owner for embedding freshness across core and storage.
// Protocol stays zod-only: callers inject the SHA-256 digester.
export function hashMemoryContent(
  content: string,
  sha256: (value: string) => string
): string {
  return `sha256:${sha256(content)}`;
}
