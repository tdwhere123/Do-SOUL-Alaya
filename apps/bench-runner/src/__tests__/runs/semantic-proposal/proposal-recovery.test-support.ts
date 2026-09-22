import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CompileSeedExtractionConfig } from "../../../runs/compile-seed/compile-seed-types.js";
import { inspectExtractionAttemptLedger } from "../../../runs/extraction/authority/attempt-ledger.js";
import { providerRawAttemptPath, writeProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { readSemanticChainProposalResults } from "../../../runs/semantic-chain/inputs.js";
import { openSemanticProposalAttemptLedger } from "../../../runs/semantic-proposal/attempt.js";
import { semanticProposalShardPath } from "../../../runs/semantic-proposal/artifact.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { executeSemanticProposalFill, prepareSemanticProposal, readSemanticProposalResults } from "../../../runs/semantic-proposal/fill.js";
import { materializeSemanticProposalLines, type SemanticProposalLine, type SemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";

/** The same filesystem recovery contract must hold for both proposal producers. */
export function proposalRecoveryCases(input: {
  workset: () => SemanticProposalWorkset;
  body: (line: SemanticProposalLine) => string;
  config: () => CompileSeedExtractionConfig;
}): void {
  describe("durable proposal recovery", () => {
    const roots: string[] = [];
    afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
    function fixture() {
      const cacheRoot = mkdtempSync(join(tmpdir(), "proposal-recovery-")); roots.push(cacheRoot);
      const workset = input.workset();
      const line = materializeSemanticProposalLines(workset, 128)[0]!;
      const authority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(workset, cacheRoot, 128),
        inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
      const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: workset.kind });
      const ledgerPath = join(cacheRoot, `extraction-attempt-ledger.${authority.attempt_lineage_digest}.json`);
      const raw = (ordinal: number, decodedText: string) => writeProviderRawAttempt({ root: cacheRoot,
        cacheKey: line.key, attemptOrdinal: ordinal, kind: line.kind, model: workset.model,
        requestProfile: workset.request_profile, requestDigest: line.requestDigest,
        attemptLineageDigest: authority.attempt_lineage_digest, decodedText, finishReason: "STOP" });
      const read = () => readSemanticProposalResults(workset, cacheRoot, 128)[0]!;
      const chain = () => readSemanticChainProposalResults(workset, cacheRoot, 128)[0]!;
      const fill = () => executeSemanticProposalFill({ workset, cacheRoot, authority,
        config: { ...input.config(), apiKey: null }, extractor: { extract: async () => { throw new Error("unexpected dispatch"); } } });
      return { cacheRoot, workset, line, authority, ledger, ledgerPath, raw, read, chain, fill };
    }

    it.each(["changed-raw", "unreserved-raw", "foreign-reservation"] as const)("rejects %s before any executable publication", async mode => {
      const f = fixture();
      if (mode === "changed-raw") f.ledger.reserveAttemptOrdinal(f.line.key);
      if (mode === "foreign-reservation") f.ledger.reserveAttemptOrdinal("f".repeat(64));
      const raw = f.raw(1, mode === "changed-raw" ? "{" : input.body(f.line));
      if (mode === "changed-raw") writeFileSync(providerRawAttemptPath(f.cacheRoot, f.line.key, 1),
        JSON.stringify({ ...raw, decoded_text: input.body(f.line) }));
      await expect(f.fill()).rejects.toThrow(/integrity mismatch|exact reserved attempt/u);
      expect(() => f.read()).toThrow(/integrity mismatch|exact reserved attempt/u);
      expect(f.chain()).toMatchObject({ status: "cache_invalid", received: undefined });
      expect(() => readFileSync(semanticProposalShardPath(f.cacheRoot, f.line.key))).toThrow(/ENOENT/u);
    });

    it("preserves a completed attempt with lost raw as incomplete without dispatching again", async () => {
      const f = fixture(); f.ledger.reserveAttemptOrdinal(f.line.key);
      f.ledger.recordTransportOutcome(f.line.key, { retryCount: 0, rateLimitRetries: 0, successfulRequestCount: 1 }, 1);
      expect(f.read().status).toBe("incomplete");
      expect(await f.fill()).toMatchObject({ unknown: 0, incomplete: 1, terminal_failures: 0, unattempted: 0, attempts: 1 });
    });

    it("does not publish successful raw against a durably failed transport attempt", async () => {
      const f = fixture(); f.ledger.reserveAttemptOrdinal(f.line.key);
      f.ledger.recordTransportOutcome(f.line.key, { retryCount: 0, rateLimitRetries: 0, successfulRequestCount: 0,
        terminalRetryClassification: "failure_non_retryable_response", transportFailures: [{ attempt: 1,
          kind: "network_error", phase: "request", httpStatus: null, fingerprint: "e".repeat(64) }] }, 1);
      f.raw(1, input.body(f.line));
      await expect(f.fill()).rejects.toThrow(/settled transport outcome/u);
      expect(f.chain()).toMatchObject({ status: "cache_invalid", received: undefined });
      expect(() => readFileSync(semanticProposalShardPath(f.cacheRoot, f.line.key))).toThrow(/ENOENT/u);
    });

    it("does not reconstruct a legacy pending reservation from aggregate attempts", async () => {
      const f = fixture(); f.ledger.reserveAttemptOrdinal(f.line.key);
      f.ledger.recordTransportOutcome(f.line.key, { retryCount: 0, rateLimitRetries: 0, successfulRequestCount: 1 }, 1);
      const old = JSON.parse(readFileSync(f.ledgerPath, "utf8")); delete old.settled_attempts;
      const bytes = JSON.stringify(old); writeFileSync(f.ledgerPath, bytes);
      expect(f.read().status).toBe("pending");
      expect(await f.fill()).toMatchObject({ unknown: 0, pending: 1, unattempted: 0, newly_admitted: 0 });
      expect(readFileSync(f.ledgerPath, "utf8")).toBe(bytes);
    });

    it("resumes after a settled retryable decoded response using its remaining attempt", async () => {
      const f = fixture(); f.ledger.reserveAttemptOrdinal(f.line.key); f.raw(1, "{");
      f.ledger.recordTransportOutcome(f.line.key, { retryCount: 0, rateLimitRetries: 0, successfulRequestCount: 1 }, 1);
      const before = readFileSync(f.ledgerPath, "utf8");
      expect(f.read().status).toBe("pending"); expect(readFileSync(f.ledgerPath, "utf8")).toBe(before);
      let calls = 0;
      const result = await executeSemanticProposalFill({ workset: f.workset, cacheRoot: f.cacheRoot, authority: f.authority,
        config: input.config(), extractor: { extract: async () => {
          calls += 1; return { rawJson: input.body(f.line), responseMetadata: { finishReason: "STOP" } };
        } } });
      expect(calls).toBe(1); expect(result).toMatchObject({ interpreted: 1, attempts: 2, unknown: 0 });
      expect(f.read().status).toBe("interpreted");
    });

    it("keeps a missing response unknown through fill and chain without settling on read", async () => {
      const f = fixture();
      expect(f.read().status).toBe("unattempted");
      f.ledger.reserveAttemptOrdinal(f.line.key);
      const before = readFileSync(f.ledgerPath, "utf8");
      expect(f.read()).toMatchObject({ status: "unknown" });
      expect(f.chain()).toMatchObject({ status: "unknown" });
      expect(f.chain().received).toBeUndefined();
      expect(await f.fill()).toMatchObject({ attempts: 1, unknown: 1, pending: 0, unattempted: 0,
        terminal_failures: 0, incomplete: 0, newly_admitted: 0 });
      expect(readFileSync(f.ledgerPath, "utf8")).toBe(before);
    });

    it("keeps retained but unsettled output pending until explicit fill recovery", async () => {
      const f = fixture(); f.ledger.reserveAttemptOrdinal(f.line.key); f.raw(1, input.body(f.line));
      const before = readFileSync(f.ledgerPath, "utf8");
      expect(f.read().status).toBe("pending"); expect(f.chain().received).toBeUndefined();
      expect(readFileSync(f.ledgerPath, "utf8")).toBe(before);
      expect(await f.fill()).toMatchObject({ interpreted: 1, unknown: 0, pending: 0 });
      expect(f.read().status).toBe("interpreted");
    });

    it("recovers crash after executable shard publication only through the write owner", async () => {
      const f = fixture(); f.ledger.reserveAttemptOrdinal(f.line.key); f.raw(1, input.body(f.line));
      const reserved = readFileSync(f.ledgerPath, "utf8");
      await f.fill(); writeFileSync(f.ledgerPath, reserved);
      const rawPath = providerRawAttemptPath(f.cacheRoot, f.line.key, 1);
      const shardPath = semanticProposalShardPath(f.cacheRoot, f.line.key);
      const rawBytes = readFileSync(rawPath, "utf8"), shardBytes = readFileSync(shardPath, "utf8");
      expect(f.read().status).toBe("pending"); expect(f.chain().received).toBeUndefined();
      expect(() => prepareSemanticProposal(f.workset, f.cacheRoot, 128))
        .toThrow(/requires fill recovery with its existing authority before preflight/u);
      expect(readFileSync(f.ledgerPath, "utf8")).toBe(reserved);
      expect(readFileSync(rawPath, "utf8")).toBe(rawBytes);
      expect(readFileSync(shardPath, "utf8")).toBe(shardBytes);
      expect(await f.fill()).toMatchObject({ interpreted: 1, unknown: 0, pending: 0 });
      expect(prepareSemanticProposal(f.workset, f.cacheRoot, 128))
        .toMatchObject({ missing: 0, maximum_attempts: 0, keys: [], provider_calls: 0 });
      const settled = inspectExtractionAttemptLedger({ cacheRoot: f.cacheRoot,
        lineageDigest: f.authority.attempt_lineage_digest,
        cacheIdentity: { model: f.workset.model, requestProfile: input.config().requestProfile } })!;
      expect(settled.settledAttempts).toEqual([{ cacheKey: f.line.key, attemptOrdinal: 1 }]);
      expect(settled.unresolvedAttempts).toEqual([]);
    });

    it.each(["raw", "ledger", "legacy-ownership", "changed-raw"] as const)("refuses a published shard after %s evidence is lost", async lost => {
      const f = fixture(); f.ledger.reserveAttemptOrdinal(f.line.key); f.raw(1, input.body(f.line)); await f.fill();
      if (lost === "raw") unlinkSync(providerRawAttemptPath(f.cacheRoot, f.line.key, 1));
      else if (lost === "ledger") unlinkSync(f.ledgerPath);
      else if (lost === "changed-raw") {
        const path = providerRawAttemptPath(f.cacheRoot, f.line.key, 1);
        const raw = JSON.parse(readFileSync(path, "utf8")); raw.decoded_text += " "; writeFileSync(path, JSON.stringify(raw));
      } else { const record = JSON.parse(readFileSync(f.ledgerPath, "utf8")); delete record.settled_attempts;
        writeFileSync(f.ledgerPath, JSON.stringify(record)); }
      expect(() => f.read()).toThrow(/reserved attempt|reserved raw|integrity mismatch/u);
      expect(f.chain()).toMatchObject({ status: "cache_invalid", received: undefined });
      expect(() => prepareSemanticProposal(f.workset, f.cacheRoot, 128)).toThrow();
      await expect(f.fill()).rejects.toThrow();
    });
  });
}
