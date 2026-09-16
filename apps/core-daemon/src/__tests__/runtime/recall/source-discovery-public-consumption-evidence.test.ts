import { describe, expect, it } from "vitest";
import { applyPublicPayloads } from "./source-discovery-public-consumer.js";
import {
  deriveRunOutcome,
  type CaseCoverage,
  type CaseIdentity
} from "./source-discovery-public-consumption-evidence.js";

const identity: CaseIdentity = {
  cell: "primary",
  group: "access",
  view: "source_only",
  enumeration: "canonical",
  lookup: "proposal"
};

describe("public consumption run outcome", () => {
  it("derives success when selected cases completed with no observed failures", () => {
    expect(deriveRunOutcome(coverage({
      selected: [identity],
      completed: [identity],
      failed: "unavailable",
      missing: [],
      file_failed: false
    }))).toBe("success");
  });

  it("does not rewrite unavailable failed into an empty list", () => {
    const result = deriveRunOutcome(coverage({
      selected: [identity],
      completed: [identity],
      failed: "unavailable",
      missing: [],
      file_failed: false
    }));
    expect(result).toBe("success");
    expect(coverage({
      selected: [identity],
      completed: [identity],
      failed: "unavailable",
      missing: [],
      file_failed: false
    }).failed).toBe("unavailable");
  });

  it("does not derive success when failed identities are observed", () => {
    expect(deriveRunOutcome(coverage({
      selected: [identity],
      completed: [identity],
      failed: [identity],
      missing: [],
      file_failed: false
    }))).not.toBe("success");
  });

  it("does not derive success when selected cases are missing", () => {
    expect(deriveRunOutcome(coverage({
      selected: [identity],
      completed: [],
      failed: "unavailable",
      missing: [identity],
      file_failed: false
    }))).toBe("failure");
    expect(deriveRunOutcome(coverage({
      selected: [identity, { ...identity, lookup: "source_text" }],
      completed: [identity],
      failed: "unavailable",
      missing: [{ ...identity, lookup: "source_text" }],
      file_failed: false
    }))).toBe("partial");
  });

  it("does not derive success when the file observed a failed vitest test", () => {
    expect(deriveRunOutcome(coverage({
      selected: [identity],
      completed: [identity],
      failed: "unavailable",
      missing: [],
      file_failed: true
    }))).not.toBe("success");
  });

  it("derives unavailable when no cases were selected", () => {
    expect(deriveRunOutcome(coverage({
      selected: [],
      completed: [],
      failed: "unavailable",
      missing: [],
      file_failed: false
    }))).toBe("unavailable");
  });
});

describe("public payload assembly", () => {
  it("records an assembly gap and does not mark the root complete on a dropped non-contiguous start", () => {
    const bodies = new Map<string, string>();
    const complete = new Map<string, boolean>();
    const assemblyGaps = new Set<string>();
    applyPublicPayloads({
      results: [payloadRow("root-1", 0, "abcd", false)]
    }, bodies, complete, assemblyGaps);
    applyPublicPayloads({
      results: [payloadRow("root-1", 10, "efgh", true)]
    }, bodies, complete, assemblyGaps);
    expect(bodies.get("root-1")).toBe("abcd");
    expect(complete.get("root-1")).toBe(false);
    expect([...assemblyGaps]).toEqual(["root-1"]);
  });
});

function coverage(input: Omit<CaseCoverage, "filtered">): CaseCoverage {
  return { ...input, filtered: "unavailable" };
}

function payloadRow(
  rootId: string,
  contentStart: number,
  preview: string,
  contentComplete: boolean
): Readonly<{
  readonly target: Readonly<{
    readonly kind: "source_evidence";
    readonly root_id: string;
    readonly span: Readonly<{ content_start: number; content_complete: boolean }>;
  }>;
  readonly content_preview: string;
}> {
  return {
    target: {
      kind: "source_evidence",
      root_id: rootId,
      span: { content_start: contentStart, content_complete: contentComplete }
    },
    content_preview: preview
  };
}
