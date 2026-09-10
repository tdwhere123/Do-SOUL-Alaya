import { describe, expect, it } from "vitest";
import type { QueryInterpretation } from "@do-soul/alaya-protocol";
import { scanSourceLiterals } from "../../../../recall/conditional-field/observers/source-literal-stream.js";
import { defaultView, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

const atoms = ["e", "\u0301", "\u0315", "\u0300", "é", "\u1100", "\u1161", "\u11a8", "😀"];
const needles = ["é", "è\u0315", "가", "각", "😀", "e😀", "absent"];

function query(): QueryInterpretation {
  return { schema_version: 1, query_id: "stream-oracle", snapshot_id: SNAPSHOT_ID,
    status: "resolved", holes: [], hypotheses: [], view: defaultView(),
    program: { schema_version: 1, kind: "hyperedge", join: "and", premises: needles.map((needle) => ({
      schema_version: 1, kind: "relation", relation_kind: "observed_log", source_variable: "s", target_variable: "t",
      facet_mode: "same_path", threshold_milligrades: 0,
      guard: { schema_version: 1, kind: "query_predicate", verdict: "unresolved",
        predicate_name: "source.literal.nfc.v1", entity_id: needle }
    })) } };
}

function* chunksOf(chars: readonly string[]): Generator<readonly string[]> {
  for (let mask = 0; mask < 2 ** Math.max(0, chars.length - 1); mask += 1) {
    const chunks: string[] = [];
    let chunk = "";
    for (const [index, char] of chars.entries()) {
      chunk += char;
      if (index === chars.length - 1 || (mask & (1 << index)) !== 0) {
        chunks.push(chunk);
        chunk = "";
      }
    }
    yield chunks;
  }
}

describe("streamed literal agreement with whole-root NFC", () => {
  it("preserves every literal verdict across Unicode composition and every three-atom partition", () => {
    const interpretation = query();
    for (const first of atoms) for (const second of atoms) for (const third of atoms) {
      const chars = [first, second, third];
      const normalized = chars.join("").normalize("NFC");
      const expected = Object.fromEntries(needles.map((needle) =>
        [needle.normalize("NFC"), normalized.includes(needle.normalize("NFC")) ? "true" : "false"]));
      for (const chunks of chunksOf(chars)) {
        let cursor: string | null = null;
        let offset = 0;
        let actual: Readonly<Record<string, string>> | undefined;
        for (const [index, content] of chunks.entries()) {
          const end = offset + Buffer.byteLength(content, "utf8");
          const scanned = scanSourceLiterals(interpretation, {
            kind: "source_record", workspace_id: "workspace-1", root_id: "root", revision: "v1", digest: "digest",
            evidence_object_id: null, event_time: null, content,
            content_start: offset, content_end: end, content_complete: index === chunks.length - 1,
            original_complete: true, retained_extent: "body"
          }, cursor, "next-root");
          expect(scanned.limited, JSON.stringify(chunks)).toBe(false);
          cursor = scanned.cursor;
          actual = scanned.row.literal_verdicts;
          offset = end;
        }
        expect(actual, JSON.stringify(chunks)).toEqual(expected);
      }
    }
  });
});
