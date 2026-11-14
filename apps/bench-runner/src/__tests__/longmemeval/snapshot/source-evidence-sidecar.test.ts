import { describe, expect, it } from "vitest";
import { extractSourceStatementSession, assertSourceStatementSessionReceipt } from "@do-soul/alaya-soul";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeSnapshotSidecar, readSnapshotSidecar } from "../../../runs/snapshot/materialize.js";
import { parseSnapshotSidecar } from
  "../../../runs/snapshot/sidecar-validation.js";
import { RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION } from
  "../../../runs/snapshot/materialize.js";

function sidecarWithDirectBindings(directEvidenceBindings: readonly unknown[]) {
  return {
    schema_version: RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
    variant: "longmemeval_s",
    questions: [{
      questionId: "q-source",
      question: "What did the assistant recommend?",
      questionDate: "2026-07-22T00:00:00.000Z",
      answerSessionIds: ["answer-session"],
      sidecar: [{
        objectId: "evidence-source",
        objectKind: "evidence_capsule" as const,
        sessionId: "answer-session",
        hasAnswer: true,
        sourceRounds: [{
          sessionIndex: 0,
          roundIndex: 0,
          sessionId: "answer-session",
          hasAnswer: true
        }]
      }],
      seedRounds: [{
        sessionIndex: 0,
        roundIndex: 0,
        sessionId: "answer-session",
        contentSha256: "a".repeat(64),
        hasAnswer: true,
        extractionSource: "cache" as const,
        cacheKey: "b".repeat(64),
        rawJsonSha256: "c".repeat(64),
        rawSignalCount: 0,
        draftCount: 0,
        factsProduced: 0,
        parseDropped: 0,
        compileOverflowDropped: 0,
        candidateAbsent: 0,
        materializationDrop: 0,
        memoryObjectIds: [],
        memoryBindings: [],
        directEvidenceBindings
      }],
      workspaceId: "workspace-source",
      runId: "run-source",
      answersWithFormation: {
        coRelevantPairs: 4,
        keptPairs: 2,
        admitted: 2
      }
    }]
  };
}

describe("snapshot source evidence sidecar", () => {
  it("round-trips an evidence capsule with source-round provenance", () => {
    const parsed = parseSnapshotSidecar(sidecarWithDirectBindings([]),
      "source-evidence.sidecar.json", RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION);

    expect(parsed.questions[0]?.sidecar).toEqual([
      expect.objectContaining({
        objectId: "evidence-source",
        objectKind: "evidence_capsule"
      })
    ]);
    expect(parsed.questions[0]?.answersWithFormation).toEqual({
      coRelevantPairs: 4,
      keptPairs: 2,
      admitted: 2
    });
  });

  it.each(["empty", "malformed", "transport_failure"] as const)(
    "retains an authored %s session receipt through real sidecar IO without promoting it", async outcome => {
      const messages = [{ message_id: "host-1", role: "user", text: "Observed input.", recorded_at: null }];
      const responses: { request: import("@do-soul/alaya-protocol").SourceStatementRequest; rawJson: string }[] = [];
      const receipt = await extractSourceStatementSession({ session_id: "session", messages, request_ceiling: 1,
        transport: async input => {
          if (outcome === "transport_failure") throw new Error("authored transport failure");
          const rawJson = outcome === "empty" ? '{"messages":[{"message_id":"host-1","statements":[]}]}' : "invalid";
          responses.push({ request: JSON.parse(input.userPrompt), rawJson });
          return { rawJson };
        } });
      expect(receipt.status).toBe(outcome === "empty" ? "complete" : "failed");
      const sidecar = sidecarWithDirectBindings([]);
      const statementSession = { receipt, responses, firstUse: true, unassignedRawStatements: 0 };
      const value = { ...sidecar, questions: [{ ...sidecar.questions[0]!, seedRounds: [{
        ...sidecar.questions[0]!.seedRounds[0]!, statementSession
      }] }] };
      const root = mkdtempSync(join(tmpdir(), "statement-sidecar-"));
      try {
        const path = join(root, "snapshot.db");
        writeSnapshotSidecar(path, value);
        const persisted = readSnapshotSidecar(path).questions[0]!.seedRounds![0]!.statementSession!;
        expect(persisted).toEqual(statementSession);
        if (outcome !== "transport_failure") assertSourceStatementSessionReceipt({ session_id: "session", messages,
          receipt: persisted.receipt, responses: persisted.responses! });
        else expect(() => assertSourceStatementSessionReceipt({ session_id: "session", messages,
          receipt: persisted.receipt, responses: persisted.responses! })).toThrow(/lacks its full session request/u);
        const forged = structuredClone(value);
        Object.assign(forged.questions[0]!.seedRounds[0]!.statementSession.receipt, { unvalidated: true });
        expect(() => writeSnapshotSidecar(path, forged)).toThrow(/malformed/u);
        expect(readSnapshotSidecar(path).questions[0]!.seedRounds![0]!.statementSession).toEqual(statementSession);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

  it("refuses a seed round that declares retired direct evidence bindings", () => {
    expect(() => parseSnapshotSidecar(
      sidecarWithDirectBindings([{ signalId: "signal-source", evidenceId: "evidence-source" }]),
      "source-evidence.sidecar.json", RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION
    )).toThrow(/retired fallback snapshot format/);
  });
});
