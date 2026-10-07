import { expect, it } from "vitest";
import {
  decodeEvidenceSelectionSourceBlocks, encodeEvidenceSelectionSourceBlocks,
  serializeEvidenceSelectionJsonInput
} from "../../../runs/evidence-selection/source-input-blocks.js";
import type { EvidenceSelectionItem } from "../../../runs/evidence-selection/input.js";

const emptyPoolFrame = "source-input-blocks-v1\nitem 30\n{\"original_question\":\"Which?\"}\nsource_count 0\nend\n";
const preview = "Lee left.\r\n\"quotes\" and \\backslash 😀漢字\nsource 3\nend\npreview 0\n\ud800";
const item: EvidenceSelectionItem = {
  original_question: "Which report?\r\n😀",
  metadata: null,
  sources: [
    {
      root_id: "src-alpha", version: "v1", digest: `sha256:${"a".repeat(64)}`,
      span: { start: 10, end: 10 + preview.length }, preview,
      metadata: { speaker: { status: "unknown" }, event_time: null, values: [false, 0, "\n"] }
    },
    {
      root_id: "src-beta", version: "v2", digest: `sha256:${"b".repeat(64)}`,
      span: { start: 0, end: 5 }, preview: "Other"
    }
  ]
};

it("matches the frozen empty-pool framing and restores omitted item metadata", () => {
  const original = { original_question: "Which?", sources: [] };
  expect(encodeEvidenceSelectionSourceBlocks(original)).toBe(emptyPoolFrame);
  expect(decodeEvidenceSelectionSourceBlocks(emptyPoolFrame)).toStrictEqual(original);
});

it("round trips the full DTO, source order, exact previews and optional metadata presence", () => {
  const encoded = encodeEvidenceSelectionSourceBlocks(item);
  const restored = decodeEvidenceSelectionSourceBlocks(encoded) as EvidenceSelectionItem;
  expect(restored).toStrictEqual(item);
  expect(encoded).toContain(`preview ${preview.length}\n${preview}\n`);
  expect(preview.length).not.toBe(Buffer.byteLength(preview, "utf8"));
  for (const [index, source] of item.sources.entries()) {
    expect(restored.sources[index]!.preview).toBe(source.preview);
    expect(Buffer.from(restored.sources[index]!.preview, "utf8")).toEqual(Buffer.from(source.preview, "utf8"));
  }
  expect(Object.hasOwn(restored, "metadata")).toBe(true);
  expect(Object.hasOwn(restored.sources[0]!, "metadata")).toBe(true);
  expect(Object.hasOwn(restored.sources[1]!, "metadata")).toBe(false);
  expect(serializeEvidenceSelectionJsonInput(restored)).toBe(serializeEvidenceSelectionJsonInput(item));
});

it("keeps source metadata null distinct from absent and rejects headers that contain framed fields", () => {
  const original = { original_question: "Which?", sources: [{ ...item.sources[1]!, metadata: null }] };
  expect(decodeEvidenceSelectionSourceBlocks(encodeEvidenceSelectionSourceBlocks(original))).toStrictEqual(original);
  const invalidHeader = '{"original_question":"Which?","sources":[]}';
  expect(() => decodeEvidenceSelectionSourceBlocks(
    `source-input-blocks-v1\nitem ${invalidHeader.length}\n${invalidHeader}\nsource_count 0\nend\n`
  )).toThrow(/framing is invalid/u);
  const sourceHeader = '{"preview":"hidden"}';
  expect(() => decodeEvidenceSelectionSourceBlocks(emptyPoolFrame.replace("source_count 0\nend\n",
    `source_count 1\nsource ${sourceHeader.length}\n${sourceHeader}\npreview 1\nx\nend\n`)))
    .toThrow(/framing is invalid/u);
});

it.each([
  ["unknown version", emptyPoolFrame.replace("blocks-v1", "blocks-v2")],
  ["leading-zero length", emptyPoolFrame.replace("item 30", "item 030")],
  ["negative length", emptyPoolFrame.replace("item 30", "item -30")],
  ["fractional length", emptyPoolFrame.replace("item 30", "item 30.0")],
  ["signed length", emptyPoolFrame.replace("item 30", "item +30")],
  ["unsafe length", emptyPoolFrame.replace("item 30", "item 9007199254740992")],
  ["short length", emptyPoolFrame.replace("item 30", "item 29")],
  ["long length", emptyPoolFrame.replace("item 30", "item 31")],
  ["wrong item label", emptyPoolFrame.replace("item 30", "source 30")],
  ["nonobject header", emptyPoolFrame.replace('item 30\n{"original_question":"Which?"}', "item 2\n[]")],
  ["malformed JSON header", emptyPoolFrame.replace('item 30\n{"original_question":"Which?"}', "item 1\n{")],
  ["missing source", emptyPoolFrame.replace("source_count 0", "source_count 1")],
  ["leading-zero count", emptyPoolFrame.replace("source_count 0", "source_count 00")],
  ["unsafe count", emptyPoolFrame.replace("source_count 0", "source_count 9007199254740992")],
  ["wrong count label", emptyPoolFrame.replace("source_count 0", "sources 0")],
  ["wrong end label", emptyPoolFrame.replace("end\n", "END\n")],
  ["missing final separator", emptyPoolFrame.slice(0, -1)],
  ["trailing data", `${emptyPoolFrame}extra\n`],
  ["truncated frame", emptyPoolFrame.slice(0, 25)],
  ["inconsistent count", encodeEvidenceSelectionSourceBlocks(item).replace("source_count 2", "source_count 1")],
  ["wrong preview label", encodeEvidenceSelectionSourceBlocks(item).replace("preview ", "body ")],
  ["inconsistent preview length", encodeEvidenceSelectionSourceBlocks(item).replace(`preview ${preview.length}`, "preview 0")]
])("rejects %s without delimiter guessing or partial recovery", (_condition, value) => {
  expect(() => decodeEvidenceSelectionSourceBlocks(value)).toThrow(/framing is invalid/u);
});
