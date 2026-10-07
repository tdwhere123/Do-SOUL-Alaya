import { AlayaError } from "@do-soul/alaya-protocol";
import type { EvidenceSelectionItem } from "./input.js";

const SOURCE_INPUT_BLOCKS_CONTRACT = "source-input-blocks-v1";

/** The historical JSON message retains its property order and omitted metadata. */
export function serializeEvidenceSelectionJsonInput(item: EvidenceSelectionItem): string {
  return JSON.stringify({
    original_question: item.original_question,
    ...(item.metadata === undefined ? {} : { metadata: item.metadata }),
    sources: item.sources.map((source) => ({
      root_id: source.root_id,
      version: source.version,
      digest: source.digest,
      span: source.span,
      preview: source.preview,
      ...(source.metadata === undefined ? {} : { metadata: source.metadata })
    }))
  });
}

/** Lengths count UTF-16 code units; preview content is never delimiter-scanned. */
export function encodeEvidenceSelectionSourceBlocks(item: EvidenceSelectionItem): string {
  const { sources, ...header } = item;
  const records = [SOURCE_INPUT_BLOCKS_CONTRACT, sizedRecord("item", JSON.stringify(header)),
    `source_count ${sources.length}`];
  for (const source of sources) {
    const { preview, ...sourceHeader } = source;
    records.push(sizedRecord("source", JSON.stringify(sourceHeader)), sizedRecord("preview", preview));
  }
  return `${records.join("\n")}\nend\n`;
}

/** Framing returns untrusted data; the input owner applies its existing item schema. */
export function decodeEvidenceSelectionSourceBlocks(value: string): unknown {
  let offset = 0;
  const line = (): string => {
    const end = value.indexOf("\n", offset);
    if (end < offset) throw framingError();
    const result = value.slice(offset, end);
    offset = end + 1;
    return result;
  };
  const integer = (label: string): number => {
    const record = line();
    if (!record.startsWith(`${label} `)) throw framingError();
    const decimal = record.slice(label.length + 1);
    if (!/^(?:0|[1-9]\d*)$/u.test(decimal)) throw framingError();
    const result = Number(decimal);
    if (!Number.isSafeInteger(result)) throw framingError();
    return result;
  };
  const sized = (label: string): string => {
    const length = integer(label);
    const end = offset + length;
    if (!Number.isSafeInteger(end) || end >= value.length || value[end] !== "\n") throw framingError();
    const result = value.slice(offset, end);
    offset = end + 1;
    return result;
  };
  if (line() !== SOURCE_INPUT_BLOCKS_CONTRACT) throw framingError();
  const header = parseHeader(sized("item"), "sources");
  const count = integer("source_count");
  if (count > value.length - offset) throw framingError();
  const sources = [];
  for (let index = 0; index < count; index += 1) {
    const source = parseHeader(sized("source"), "preview");
    sources.push({ ...source, preview: sized("preview") });
  }
  if (line() !== "end" || offset !== value.length) throw framingError();
  return { ...header, sources };
}

function sizedRecord(label: string, value: string): string {
  return `${label} ${value.length}\n${value}`;
}

function parseHeader(value: string, excludedField: string): Record<string, unknown> {
  let header: unknown;
  try { header = JSON.parse(value); } catch { throw framingError(); }
  if (typeof header !== "object" || header === null || Array.isArray(header) ||
      Object.hasOwn(header, excludedField)) throw framingError();
  return header as Record<string, unknown>;
}

function framingError(): AlayaError {
  return new AlayaError("VALIDATION", "evidence selection source input framing is invalid");
}
