import { C02_POLICY, compareIdentity, frameEntry, type SourceBinding } from "./types.js";

export interface SourceSpanInput {
  readonly id: string;
  readonly source: SourceBinding;
  readonly sourceText: string;
  readonly startByte: number;
  readonly endByte: number;
}

export interface RenderEntry {
  readonly object_id: string;
  readonly content: string;
  readonly source?: SourceBinding;
  readonly sourceSpans?: readonly Readonly<{ startByte: number; endByte: number }>[];
  readonly framedContent: string;
  readonly framedBytes: number;
  readonly chargedTokens: number;
}

/** Supplied only by the composition owner of an already verified local tokenizer. */
export interface HostTokenizer {
  readonly profile: "cl100k_base" | "o200k_base";
  readonly implementation: string;
  readonly assetSha256: string;
  readonly encodeOrdinary: (text: string) => readonly number[];
}

export function preRenderEntry(input: {
  readonly object_id: string;
  readonly content: string;
  readonly source?: SourceBinding;
  readonly sourceSpans?: RenderEntry["sourceSpans"];
}): RenderEntry {
  const framedContent = frameEntry(input.object_id, input.content);
  const framedBytes = Buffer.byteLength(framedContent, "utf8");
  return Object.freeze({
    object_id: input.object_id, content: input.content,
    ...(input.source ? { source: Object.freeze({ ...input.source,
      evidenceRefs: Object.freeze([...input.source.evidenceRefs]) }) } : {}),
    ...(input.sourceSpans ? { sourceSpans: Object.freeze(input.sourceSpans.map((span) => Object.freeze({ ...span }))) } : {}),
    framedContent, framedBytes, chargedTokens: framedBytes * C02_POLICY.tokensPerUtf8Byte
  });
}

export function coalesceSourceSpans(inputs: readonly SourceSpanInput[]): readonly RenderEntry[] {
  const byObject = new Map<string, SourceSpanInput[]>();
  for (const input of inputs) {
    const group = byObject.get(input.id) ?? [];
    group.push(input);
    byObject.set(input.id, group);
  }
  return Object.freeze([...byObject].sort(([a], [b]) => compareIdentity(a, b))
    .map(([id, spans]) => coalesceObject(id, spans)));
}

function coalesceObject(id: string, inputs: readonly SourceSpanInput[]): RenderEntry {
  const first = inputs[0]!;
  const bytes = Buffer.from(first.sourceText, "utf8");
  const ranges: { startByte: number; endByte: number }[] = [];
  const evidenceRefs = new Set<string>();
  for (const input of [...inputs].sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte)) {
    if (input.sourceText !== first.sourceText || input.source.workspaceId !== first.source.workspaceId ||
      input.source.sourceObjectId !== first.source.sourceObjectId || input.source.sourceRevision !== first.source.sourceRevision) {
      throw new Error("source-span identity or revision conflict");
    }
    if (!Number.isSafeInteger(input.startByte) || !Number.isSafeInteger(input.endByte) ||
      input.startByte < 0 || input.endByte <= input.startByte || input.endByte > bytes.length) {
      throw new Error("invalid source-span range");
    }
    for (const boundary of [input.startByte, input.endByte]) {
      if (boundary < bytes.length && (bytes[boundary]! & 0xc0) === 0x80) throw new Error("source span splits UTF-8 code point");
    }
    input.source.evidenceRefs.forEach((ref) => evidenceRefs.add(ref));
    const previous = ranges.at(-1);
    if (previous && input.startByte <= previous.endByte) previous.endByte = Math.max(previous.endByte, input.endByte);
    else ranges.push({ startByte: input.startByte, endByte: input.endByte });
  }
  // A visible separator prevents disjoint source ranges from inventing adjacent text.
  const content = ranges.map((range) => bytes.subarray(range.startByte, range.endByte).toString("utf8")).join("\n");
  return preRenderEntry({ object_id: id, content, sourceSpans: ranges,
    source: { ...first.source, evidenceRefs: [...evidenceRefs].sort(compareIdentity) } });
}

export function renderPlannedContext(
  entries: readonly RenderEntry[],
  order: readonly string[],
  tokenizer?: HostTokenizer,
  envelopeBytes: number = C02_POLICY.envelopeBytes
): Readonly<{ context: string; actualBytes: number; chargedTokens: number;
  envelopeAllowance: number; actualTokens: number | null; tokenizerProfile: string | null }> {
  if (!Number.isSafeInteger(envelopeBytes) || envelopeBytes < 0) throw new Error("invalid envelope allowance");
  if (tokenizer && (!new Set(["cl100k_base", "o200k_base"]).has(tokenizer.profile) ||
    tokenizer.implementation.length === 0 || !/^[a-f0-9]{64}$/u.test(tokenizer.assetSha256))) {
    throw new Error("unsupported or unidentified host tokenizer profile");
  }
  const byId = new Map(entries.map((entry) => [entry.object_id, entry]));
  if (byId.size !== entries.length || new Set(order).size !== order.length) throw new Error("duplicate rendered object");
  let plannedBytes = 0;
  let chargedTokens = 0;
  const chunks = order.map((id) => {
    const entry = byId.get(id);
    if (!entry || entry.framedContent !== frameEntry(entry.object_id, entry.content) ||
      entry.framedBytes !== Buffer.byteLength(entry.framedContent, "utf8") || entry.chargedTokens !== entry.framedBytes) {
      throw new Error("missing or inconsistent pre-rendered entry");
    }
    plannedBytes += entry.framedBytes;
    chargedTokens += entry.chargedTokens;
    return entry.framedContent;
  });
  const context = chunks.join("");
  const actualBytes = Buffer.byteLength(context, "utf8");
  const envelopeAllowance = order.length === 0 ? 0 : envelopeBytes;
  chargedTokens += envelopeAllowance;
  if (actualBytes !== plannedBytes) throw new Error("planned context byte mismatch");
  const actualTokens = tokenizer ? tokenizer.encodeOrdinary(context).length : null;
  if (actualTokens !== null && actualTokens > actualBytes) throw new Error("host tokenizer violates UTF-8 byte ceiling");
  return Object.freeze({ context, actualBytes, chargedTokens, envelopeAllowance, actualTokens,
    tokenizerProfile: tokenizer?.profile ?? null });
}
