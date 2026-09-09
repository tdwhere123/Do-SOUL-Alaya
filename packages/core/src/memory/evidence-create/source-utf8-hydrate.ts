import { assertSpanInContent, isUtf8Boundary, sliceUtf8Span } from "./source-span-views.js";

export type Utf8HydrateChunk = Readonly<{
  readonly status: "chunk";
  readonly text: string;
  readonly start_offset: number;
  readonly end_offset: number;
  readonly complete: boolean;
  readonly next_offset: number | null;
}>;

export type Utf8HydrateUnavailable = Readonly<{
  readonly status: "unavailable";
  readonly reason: "out_of_range" | "utf8_boundary";
}>;

export type Utf8HydrateResult = Utf8HydrateChunk | Utf8HydrateUnavailable;

export function hydrateUtf8Chunk(
  content: string,
  input: Readonly<{
    readonly offset?: number;
    readonly byteLimit: number;
  }>
): Utf8HydrateResult {
  const bytes = Buffer.from(content, "utf8");
  const offset = input.offset ?? 0;
  const byteLimit = input.byteLimit;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) {
    return { status: "unavailable", reason: "out_of_range" };
  }
  if (!isUtf8Boundary(bytes, offset)) {
    return { status: "unavailable", reason: "utf8_boundary" };
  }
  if (offset === bytes.length) {
    return {
      status: "chunk",
      text: "",
      start_offset: offset,
      end_offset: offset,
      complete: true,
      next_offset: null
    };
  }
  let end = Math.min(bytes.length, offset + byteLimit);
  while (end > offset && !isUtf8Boundary(bytes, end)) end -= 1;
  if (end === offset) {
    end = nextCodepointEnd(bytes, offset);
  }
  const span = { start_offset: offset, end_offset: end, purpose: "native_structure" as const };
  const text = end === offset ? "" : sliceUtf8Span(content, assertSpanInContent(content, span));
  const complete = end === bytes.length;
  return {
    status: "chunk",
    text,
    start_offset: offset,
    end_offset: end,
    complete,
    next_offset: complete ? null : end
  };
}

function nextCodepointEnd(bytes: Buffer, offset: number): number {
  const lead = bytes[offset]!;
  const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
  return Math.min(bytes.length, offset + width);
}

export function normalizeSourceLiteralNfc(text: string): string {
  return text.normalize("NFC");
}

export function sourceLiteralOccurs(body: string, needle: string): boolean {
  if (needle.length === 0) return true;
  return normalizeSourceLiteralNfc(body).includes(normalizeSourceLiteralNfc(needle));
}

export function hydrateLoadedSourceContent(
  content: string | undefined,
  input: Readonly<{ readonly offset?: number; readonly byteLimit: number }>
): Utf8HydrateResult | { readonly status: "unavailable"; readonly reason: "missing" } {
  if (content === undefined) return { status: "unavailable", reason: "missing" };
  return hydrateUtf8Chunk(content, input);
}
