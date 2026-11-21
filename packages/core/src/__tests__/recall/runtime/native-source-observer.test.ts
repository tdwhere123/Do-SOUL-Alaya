import { describe, expect, it } from "vitest";
import { SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { nativeSourceReaders } from "../../../recall/runtime/native-source-observer.js";

const target = {
  kind: "source_evidence" as const,
  workspace_id: "workspace-1",
  root_kind: "source_record" as const,
  root_id: "root-1",
  source_version: "1",
  content_digest: "a".repeat(64),
  evidence_object_id: null
};

function observe(afterCursor: string | null) {
  const offsets: number[] = [];
  const readers = nativeSourceReaders({
    sourceRoot: ({ offset = 0 }) => {
      offsets.push(offset);
      return { row: null, rowsRead: 0, bytesRead: 0, unavailable: false };
    }
  }, { result: null, witness: [], admitted_roots: [target] },
    new SourceSemanticResourceLedger({ work_units: 1_000, memory_bytes: 10_000 }));
  return {
    offsets,
    page: readers.sourceRoots!({ workspaceId: "workspace-1", limit: 1, nativeLimit: 1, afterCursor })
  };
}

describe("native source observer frozen cursor", () => {
  it("treats a null cursor as slot 0", () => {
    expect(observe(null).offsets).toEqual([0]);
  });

  it("rejects empty, whitespace, and non-canonical integer cursors", () => {
    for (const afterCursor of ["", " ", "01", "1.0", "+0", "-1"]) {
      expect(() => observe(afterCursor)).toThrow(/Invalid frozen source nomination cursor/u);
    }
  });

  it("accepts a canonical integer cursor", () => {
    const empty = observe("1");
    expect(empty.offsets).toEqual([]);
    expect(empty.page.rows).toEqual([]);
  });
});
