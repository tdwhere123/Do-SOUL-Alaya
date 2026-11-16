import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SoulMemorySearchResponse } from "@do-soul/alaya-protocol";
import { SOURCE_DISCOVERY_CANARY } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/observers/source-discovery-canary.fixture.js";
import { RUN, WS } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import { applyPublicPayloads, consumePublicSources } from "./source-discovery-public-consumer.js";
import { publicSearchRequest, type PublicConsumer } from "./source-discovery-public-consumption.js";
import {
  deriveRunOutcome,
  persistRunEvidence,
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

describe("public consumption evidence output", () => {
  let root: string;
  let repository: string;
  let originalDirectory: string;
  const input = {
    rows: [{ source: "retained source" }],
    traces: [{ operation: "read" }],
    selected: [identity],
    completed: [identity],
    failed: [],
    fileFailed: false
  };

  beforeEach(() => {
    originalDirectory = process.cwd();
    root = mkdtempSync(join(tmpdir(), "alaya-consumption-evidence-"));
    repository = join(root, "repository");
    execFileSync("git", ["init", "--quiet", repository]);
    execFileSync("git", [
      "-C", repository, "-c", "user.name=Evidence Test", "-c", "user.email=evidence@example.invalid",
      "commit", "--quiet", "--allow-empty", "-m", "Clean evidence candidate"
    ]);
    process.chdir(repository);
  });

  afterEach(() => {
    process.chdir(originalDirectory);
    rmSync(root, { recursive: true, force: true });
  });

  it("does not write when no output directory is supplied for a clean candidate", () => {
    persistRunEvidence(input);
    expect(readdirSync(repository)).toEqual([".git"]);
  });

  it.each(["", "   "])("does not write for a blank output directory (%j)", (evidenceDirectory) => {
    persistRunEvidence({ ...input, evidenceDirectory });
    expect(readdirSync(repository)).toEqual([".git"]);
  });

  it("writes paired evidence only into the explicitly selected directory", () => {
    const evidenceDirectory = join(root, "requested-output");
    const sha = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    persistRunEvidence({ ...input, evidenceDirectory });
    const directory = join(evidenceDirectory, "public-source-consumption-runs", sha);
    const files = readdirSync(directory);
    expect(files).toHaveLength(2);
    const matrix = JSON.parse(readFileSync(join(directory, files.find((name) => name.endsWith("-matrix.json"))!), "utf8"));
    const traces = JSON.parse(readFileSync(join(directory, files.find((name) => name.endsWith("-traces.json"))!), "utf8"));
    expect(matrix).toMatchObject({ result_identity: { result_sha: sha }, run_outcome: "success", rows: input.rows });
    expect(traces).toMatchObject({ result_identity: { result_sha: sha }, run_outcome: "success", traces: input.traces });
    expect(readdirSync(repository)).toEqual([".git"]);
  });

  it("still refuses to attribute an explicitly requested output to a dirty candidate", () => {
    const evidenceDirectory = join(root, "requested-output");
    writeFileSync(join(repository, "untracked.txt"), "not committed");
    persistRunEvidence({ ...input, evidenceDirectory });
    expect(existsSync(evidenceDirectory)).toBe(false);
  });

  it("propagates an explicit destination failure without overwriting existing content", () => {
    const evidenceDirectory = join(root, "requested-output");
    writeFileSync(evidenceDirectory, "existing file");
    expect(() => persistRunEvidence({ ...input, evidenceDirectory })).toThrow();
    expect(readFileSync(evidenceDirectory, "utf8")).toBe("existing file");
  });
});

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

  it("does not treat a payload page that omits the pending root as complete", async () => {
    const canary = SOURCE_DISCOVERY_CANARY[0]!;
    const rootId = "root-unread-1";
    const digest = `sha256:${"ab".repeat(32)}`;
    const omittedTarget = {
      kind: "source_evidence" as const,
      workspace_id: WS,
      root_kind: "source_record" as const,
      root_id: rootId,
      source_version: "version-1",
      content_digest: digest,
      evidence_object_id: null,
      span: {
        content_start: 0,
        content_end: 0,
        retained_extent: "body" as const,
        content_complete: false,
        original_complete: false
      }
    };
    const handler: PublicConsumer = async (request) => {
      if (request.payload_continuation === undefined) {
        return {
          delivery_id: "delivery-omit-pending",
          protocol_version: 1 as const,
          results: [{
            object_id: rootId,
            object_kind: "source_evidence",
            content_preview: "[payload omitted]",
            relevance_score: 1,
            target: omittedTarget
          }],
          total_count: 1,
          index: {
            page_purpose: "membership" as const,
            completeness: { logical_index: "partial", payload: "omitted" }
          }
        } as unknown as SoulMemorySearchResponse;
      }
      return {
        delivery_id: "delivery-omit-pending",
        protocol_version: 1 as const,
        results: [],
        total_count: 0,
        index: {
          page_purpose: "payload_expansion" as const,
          completeness: { logical_index: "partial", payload: "omitted" }
        }
      } as unknown as SoulMemorySearchResponse;
    };
    const trace = await consumePublicSources({
      handler,
      context: { workspaceId: WS, runId: RUN, sessionId: RUN, agentTarget: "codex" },
      request: publicSearchRequest(canary, "proposal", "source_only", "canonical", 1),
      receipts: []
    });
    expect(trace.termination.discarded_capped_incomplete_root_ids).toEqual([rootId]);
    expect(trace.termination.cap_remainder).toBe("unread_after_cap");
    expect(trace.termination.stop_reason).not.toBeUndefined();
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
