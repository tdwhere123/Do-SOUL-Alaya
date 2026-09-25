import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { CompileSeedExtractionConfig } from "../../../runs/compile-seed/compile-seed-types.js";
import { inspectProviderChatCompletionResponse, MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES } from "@do-soul/alaya-engine-gateway";
import { readProviderResponseWithEvidence } from "../../../../../../packages/engine-gateway/src/provider/chat-completion/response-evidence.js";
import { inspectExtractionAttemptLedger } from "../../../runs/extraction/authority/attempt-ledger.js";
import { providerRawAttemptPath, providerRawSuccessEvidenceState, readProviderRawAttempt,
  writeProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { STEP_PLAN_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import { readSemanticChainProposalResults } from "../../../runs/semantic-chain/inputs.js";
import { inspectPopulationAttemptScopes } from "../../../runs/longmemeval-semantic/population-attempts.js";
import { openSemanticProposalAttemptLedger } from "../../../runs/semantic-proposal/attempt.js";
import { semanticProposalShardPath } from "../../../runs/semantic-proposal/artifact.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { executeSemanticProposalFill, prepareSemanticProposal, readSemanticProposalResults } from "../../../runs/semantic-proposal/fill.js";
import { materializeSemanticProposalLines, parseSemanticProposalWorkset,
  type SemanticProposalLine, type SemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { syntheticGeminiBody } from "./gemini-response-evidence.test-support.js";

const execFileAsync = promisify(execFile);

/** The same filesystem recovery contract must hold for both proposal producers. */
export function proposalRecoveryCases(input: {
  workset: () => SemanticProposalWorkset;
  body: (line: SemanticProposalLine) => string;
  config: () => CompileSeedExtractionConfig;
}): void {
  describe("durable proposal recovery", () => {
    const roots: string[] = [];
    afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
    function fixture(maxOutputTokens = 128) {
      const cacheRoot = mkdtempSync(join(tmpdir(), "proposal-recovery-")); roots.push(cacheRoot);
      const workset = input.workset();
      const line = materializeSemanticProposalLines(workset, maxOutputTokens)[0]!;
      const authority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(workset, cacheRoot, maxOutputTokens),
        inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
      const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: workset.kind });
      const ledgerPath = join(cacheRoot, `extraction-attempt-ledger.${authority.attempt_lineage_digest}.json`);
      const raw = (ordinal: number, decodedText: string, usage?: { inputTokens: number; outputTokens: number; totalTokens: number },
        physical: "bound" | "missing" | "truncated" = "bound") => writeProviderRawAttempt({ root: cacheRoot,
        cacheKey: line.key, attemptOrdinal: ordinal, kind: line.kind, model: workset.model,
        requestProfile: workset.request_profile, requestDigest: line.requestDigest,
        attemptLineageDigest: authority.attempt_lineage_digest, decodedText, finishReason: "STOP", ...(usage ? { usage } : {}),
        ...(physical === "missing" ? {} : { responseBody: syntheticGeminiBody(decodedText, "STOP", usage) +
          (physical === "truncated" ? " ".repeat(1024 * 1024) : "") }) });
      const read = () => readSemanticProposalResults(workset, cacheRoot, maxOutputTokens)[0]!;
      const chain = () => readSemanticChainProposalResults(workset, cacheRoot, maxOutputTokens)[0]!;
      const fill = () => executeSemanticProposalFill({ workset, cacheRoot, authority,
        config: { ...input.config(), apiKey: null }, extractor: { extract: async () => { throw new Error("unexpected dispatch"); } } });
      const restart = async () => {
        writeFileSync(join(cacheRoot, "workset.json"), JSON.stringify(workset));
        const authorityPath = join(cacheRoot, "authority.json");
        writeFileSync(authorityPath, JSON.stringify(authority));
        const { stdout } = await execFileAsync(process.execPath, [join(import.meta.dirname, "proposal-process-fixture.mjs")], {
          cwd: process.cwd(), timeout: 30_000, env: { ...process.env, PROPOSAL_CACHE_ROOT: cacheRoot,
            PROPOSAL_PROCESS_MODE: "recover", PROPOSAL_AUTHORITY_PATH: authorityPath }
        });
        const prefix = "PROPOSAL_RECOVERY_RESULT:";
        const result = stdout.split(/\r?\n/u).find(line => line.startsWith(prefix));
        if (result === undefined) {
          throw new Error(`recovery child did not emit its result: ${JSON.stringify(stdout.slice(0, 2048))}`);
        }
        return JSON.parse(result.slice(prefix.length));
      };
      return { cacheRoot, workset, line, authority, ledger, ledgerPath, raw, read, chain, fill, restart };
    }

    it.each([true, false].flatMap(truncated => [true, false].map(usageKnown => ({ truncated, usageKnown }))))(
      "retains native Step evidence with truncated=$truncated usageKnown=$usageKnown without a second attempt",
      async ({ truncated, usageKnown }) => {
        const cacheRoot = mkdtempSync(join(tmpdir(), "proposal-step-retention-")); roots.push(cacheRoot);
        const workset = parseSemanticProposalWorkset({ ...input.workset(),
          contract: "source-semantic-proposal-workset-v4",
          provider_url: STEP_PLAN_QUOTE_BASIS.selected_provider_url,
          model: STEP_PLAN_QUOTE_BASIS.selected_model,
          request_profile: "step-3.5-2603-low-json-schema-v1" });
        const authority = pinSemanticProposalAuthority({
          preflight: prepareSemanticProposal(workset, cacheRoot, 4096, 1),
          inputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.input_usd_equivalent_per_million,
          outputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.output_usd_equivalent_per_million
        });
        const line = materializeSemanticProposalLines(workset, 4096)[0]!;
        const usage = usageKnown ? { prompt_tokens: 11, completion_tokens: 17, total_tokens: 28 } : undefined;
        const physical = JSON.stringify({ choices: [{ finish_reason: "stop",
          message: { content: input.body(line) } }], ...(usage === undefined ? {} : { usage }) }) +
          (truncated ? " ".repeat(MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES) : "");
        const retained = await readProviderResponseWithEvidence(new Response(physical, {
          headers: { "content-type": "application/json" }
        }));
        const decoded = inspectProviderChatCompletionResponse(retained.bodyText,
          retained.evidence.contentType, 200, { sseCompletionPolicy: "require_witness" });
        const config: CompileSeedExtractionConfig = { model: workset.model,
          requestProfile: "step-3.5-2603-low-json-schema-v1",
          providerUrl: workset.provider_url, apiKey: "synthetic-only" };
        let calls = 0;
        const extractor = { extract: async () => { calls += 1; return {
          rawJson: decoded.text, responseMetadata: { finishReason: decoded.finishReason },
          ...(decoded.usage === undefined ? {} : { usage: decoded.usage }), httpResponse: retained.evidence
        }; } };
        const fill = () => executeSemanticProposalFill({ workset, cacheRoot, authority, config, extractor });
        if (truncated) await expect(fill()).rejects.toThrow(/stopped after incomplete/u);
        else await expect(fill()).resolves.toMatchObject({ newly_admitted: 1, attempts: 1 });
        expect(calls).toBe(1);
        const raw = readProviderRawAttempt(cacheRoot, line.key, 1)!;
        expect(raw.http_response).toMatchObject({ bodyTruncated: truncated, bodyComplete: true });
        expect(providerRawSuccessEvidenceState(raw)).toBe(truncated ? "truncated" : "bound");
        const rawBytes = readFileSync(providerRawAttemptPath(cacheRoot, line.key, 1));
        const result = readSemanticProposalResults(workset, cacheRoot, 4096)[0]!;
        expect(result.status).toBe(truncated ? "incomplete" : "interpreted");
        const chain = readSemanticChainProposalResults(workset, cacheRoot, 4096)[0];
        if (truncated) expect(chain?.received).toBeUndefined();
        else expect(chain?.received).toBeDefined();
        const before = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: workset.kind }).snapshot();
        expect(before).toMatchObject({ attempts: 1, successfulShards: truncated ? 0 : 1 });
        expect(before.telemetry.totalTokens).toBe(usageKnown ? 28 : 0);
        if (truncated) await expect(fill()).rejects.toThrow(/retained incomplete/u);
        else await expect(fill()).resolves.toMatchObject({ attempts: 0, cache_hits: 1 });
        expect(calls).toBe(1);
        expect(readFileSync(providerRawAttemptPath(cacheRoot, line.key, 1)).equals(rawBytes)).toBe(true);
        const after = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: workset.kind }).snapshot();
        expect(after).toEqual(before);
      }
    );

    it.each([true, false].flatMap(truncated => [true, false].flatMap(usageKnown =>
      ["live", "retained recovery"].map(path => ({ truncated, usageKnown, path })))))
    ("reopens escaped proposal raw through $path with truncated=$truncated usageKnown=$usageKnown", async ({ truncated, usageKnown, path }) => {
      const f = fixture(65536);
      const prefix = truncated ? input.body(f.line) : "{}";
      const text = prefix + "\n".repeat(1024 * 1024 - Buffer.byteLength(prefix) + (truncated ? 4 : 0));
      const usage = usageKnown ? { inputTokens: 2, outputTokens: 3, totalTokens: 5 } : undefined;
      let calls = 0;
      if (path === "retained recovery") {
        f.ledger.reserveAttemptOrdinal(f.line.key); f.raw(1, text, usage);
        expect(f.read().status).toBe("pending");
        expect(await f.restart()).toMatchObject({ statuses: ["incomplete"] });
      } else {
        await executeSemanticProposalFill({ workset: f.workset, cacheRoot: f.cacheRoot, authority: f.authority,
          config: input.config(), extractor: { extract: async () => {
            calls += 1; return { rawJson: text, responseMetadata: { finishReason: "STOP" },
              responseBody: syntheticGeminiBody(text, "STOP", usage), ...(usage ? { usage } : {}) };
          } } });
      }
      const raw = readProviderRawAttempt(f.cacheRoot, f.line.key, 1)!;
      expect(raw).toMatchObject({ full_replay_possible: !truncated, decoded_text_truncated: truncated,
        original_byte_length: Buffer.byteLength(text), decoded_text_digest: createHash("sha256").update(text).digest("hex"),
        finish_reason: "STOP", usage_known: usageKnown, usage: usage ?? null });
      if (truncated) expect(JSON.parse(raw.decoded_text)).toEqual(JSON.parse(prefix));
      const status = "incomplete";
      expect(f.read().status).toBe(status);
      expect(f.chain().received).toBeUndefined();
      expect(JSON.parse(readFileSync(semanticProposalShardPath(f.cacheRoot, f.line.key), "utf8"))).toMatchObject({ admitted: false });
      const settled = JSON.parse(readFileSync(f.ledgerPath, "utf8"));
      expect(settled).toMatchObject({ attempts: 1, unresolved_attempts: [],
        settled_attempts: [{ cache_key: f.line.key, attempt_ordinal: 1 }], successful_shards: [],
        telemetry: { input_tokens: usageKnown ? 2 : 0, output_tokens: usageKnown ? 3 : 0,
          total_tokens: usageKnown ? 5 : 0, usage_unavailable_requests: usageKnown ? 0 : 1 } });
      const rawBytes = readFileSync(providerRawAttemptPath(f.cacheRoot, f.line.key, 1));
      for (let replay = 0; replay < 2; replay += 1) {
        const summary = replay === 0 && path === "live" ? (await f.restart()).summary : await f.fill();
        expect(summary).toMatchObject({ pending: 0, newly_admitted: 0, unknown: 0,
          incomplete: 1 });
        expect(f.read().status).toBe(status);
        expect(f.chain().received).toBeUndefined();
        expect(JSON.parse(readFileSync(f.ledgerPath, "utf8"))).toEqual(settled);
        expect(readFileSync(providerRawAttemptPath(f.cacheRoot, f.line.key, 1)).equals(rawBytes)).toBe(true);
      }
      expect(calls).toBe(path === "live" ? 1 : 0);
    });

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

    it("binds successful reopen to the authorized physical route and exact attempt", async () => {
      const f = fixture();
      const ordinal = f.ledger.reserveAttemptOrdinal(f.line.key);
      f.raw(ordinal, input.body(f.line), { inputTokens: 2, outputTokens: 3, totalTokens: 5 });
      expect(await f.fill()).toMatchObject({ attempts: 1, newly_admitted: 1 });
      const ledger = openSemanticProposalAttemptLedger({ cacheRoot: f.cacheRoot,
        authority: f.authority, kind: f.workset.kind }).snapshot();
      expect(ledger).toMatchObject({ attempts: 1, successfulShards: 1,
        successfulEntries: [{ successKind: "provider", attemptOrdinal: ordinal,
          authorityLineageDigest: f.authority.attempt_lineage_digest,
          transportProvenance: f.authority.transport_provenance }] });
      const path = semanticProposalShardPath(f.cacheRoot, f.line.key);
      const original = readFileSync(path, "utf8");
      const bytes = readFileSync(f.ledgerPath, "utf8");
      for (const damage of ["model", "route", "attempt", "lineage"] as const) {
        const shard = JSON.parse(original);
        if (damage === "model") shard.transport_provenance.model = "foreign-physical-model";
        else if (damage === "route") shard.transport_provenance.provider_url_sha256 = `sha256:${"f".repeat(64)}`;
        else if (damage === "attempt") shard.attempt_ordinal = ordinal + 1;
        else shard.attempt_lineage_digest = "f".repeat(64);
        writeFileSync(path, JSON.stringify(shard));
        expect(() => openSemanticProposalAttemptLedger({ cacheRoot: f.cacheRoot,
          authority: f.authority, kind: f.workset.kind })).toThrow();
        expect(readFileSync(f.ledgerPath, "utf8")).toBe(bytes);
      }
      writeFileSync(path, original);
      expect(openSemanticProposalAttemptLedger({ cacheRoot: f.cacheRoot,
        authority: f.authority, kind: f.workset.kind }).snapshot().successfulShards).toBe(1);
    });

    it("keeps a staged admitted shard unresolved until its same attempt settles", async () => {
      const f = fixture();
      const ordinal = f.ledger.reserveAttemptOrdinal(f.line.key);
      const reserved = readFileSync(f.ledgerPath, "utf8");
      f.raw(ordinal, input.body(f.line), { inputTokens: 2, outputTokens: 3, totalTokens: 5 });
      expect(await f.fill()).toMatchObject({ attempts: 1, newly_admitted: 1 });
      writeFileSync(f.ledgerPath, reserved);
      expect(f.read().status).toBe("pending");
      const reopened = openSemanticProposalAttemptLedger({ cacheRoot: f.cacheRoot,
        authority: f.authority, kind: f.workset.kind }).snapshot();
      expect(reopened).toMatchObject({ attempts: 1, successfulShards: 0,
        unresolvedAttempts: [{ cacheKey: f.line.key, attemptOrdinal: ordinal }], settledAttempts: [] });
      expect(readFileSync(f.ledgerPath, "utf8")).toBe(reserved);
      expect(await f.fill()).toMatchObject({ attempts: 0, cache_hits: 1, newly_admitted: 0 });
      expect(openSemanticProposalAttemptLedger({ cacheRoot: f.cacheRoot,
        authority: f.authority, kind: f.workset.kind }).snapshot()).toMatchObject({
          attempts: 1, successfulShards: 1, unresolvedAttempts: [],
          settledAttempts: [{ cacheKey: f.line.key, attemptOrdinal: ordinal }] });
      expect(await f.restart()).toMatchObject({ statuses: ["interpreted"] });
    });

    it("does not spend again when a prior settled attempt has lost its named history", async () => {
      const f = fixture();
      f.ledger.reserveAttemptOrdinal(f.line.key);
      f.ledger.recordTransportOutcome(f.line.key, { retryCount: 0, rateLimitRetries: 0,
        successfulRequestCount: 1, usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } }, 1);
      const record = JSON.parse(readFileSync(f.ledgerPath, "utf8"));
      delete record.settled_attempts;
      writeFileSync(f.ledgerPath, JSON.stringify(record));
      const before = readFileSync(f.ledgerPath, "utf8");
      expect(f.read().status).toBe("incomplete");
      expect(inspectPopulationAttemptScopes([{ layer: f.workset.kind === "query" ? "query" : "correspondence",
        cacheRoot: f.cacheRoot, model: f.workset.model, requestProfile: f.workset.request_profile,
        keys: [f.line.key] }])).toMatchObject({ inspected_scope_history_complete: false,
        scoped_authorized_attempts: null });
      let calls = 0;
      await expect(executeSemanticProposalFill({ workset: f.workset, cacheRoot: f.cacheRoot,
        authority: f.authority, config: input.config(), extractor: { extract: async () => {
          calls += 1; throw new Error("must not dispatch");
        } } })).resolves.toMatchObject({ attempts: 0, incomplete: 1, newly_admitted: 0 });
      expect(calls).toBe(0);
      expect(readFileSync(f.ledgerPath, "utf8")).toBe(before);
    });

    it.each([true, false].flatMap(usageKnown =>
      (["settled", "failure-only"] as const).map(history => ({ usageKnown, history }))))(
      "keeps lost $history terminal failure spent with known usage=$usageKnown", async ({ usageKnown, history }) => {
        const f = fixture();
        const ordinal = f.ledger.reserveAttemptOrdinal(f.line.key);
        const failure = { attempt: 1, kind: "response_parse_error" as const, phase: "response_parse" as const,
          httpStatus: 200, fingerprint: "e".repeat(64) };
        writeProviderRawAttempt({ root: f.cacheRoot, cacheKey: f.line.key, attemptOrdinal: ordinal,
          kind: f.workset.kind, model: f.workset.model, requestProfile: f.workset.request_profile,
          requestDigest: f.line.requestDigest, attemptLineageDigest: f.authority.attempt_lineage_digest,
          decodedText: "", finishReason: null, transportFailure: failure, failureRetryable: false,
          failureClassification: "failure_non_retryable_response",
          ...(usageKnown ? { usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } } : {}) });
        expect(f.read().status).toBe("pending");
        expect(await f.fill()).toMatchObject({ attempts: 1, terminal_failures: 1, newly_admitted: 0 });
        expect(f.read().status).toBe("transport_failure");
        unlinkSync(semanticProposalShardPath(f.cacheRoot, f.line.key));
        unlinkSync(providerRawAttemptPath(f.cacheRoot, f.line.key, ordinal));
        if (history === "failure-only") {
          const record = JSON.parse(readFileSync(f.ledgerPath, "utf8"));
          delete record.settled_attempts;
          writeFileSync(f.ledgerPath, JSON.stringify(record));
        }
        const bytes = readFileSync(f.ledgerPath);
        const before = openSemanticProposalAttemptLedger({ cacheRoot: f.cacheRoot,
          authority: f.authority, kind: f.workset.kind }).snapshot();
        expect(before).toMatchObject({ attempts: 1, successfulShards: 0,
          unresolvedAttempts: [], transportFailures: [{ attemptOrdinal: 1, cacheKey: f.line.key }],
          telemetry: { totalTokens: usageKnown ? 5 : 0, usageUnknownAttempts: usageKnown ? 0 : 1,
            terminalRetryClassifications: { failure_non_retryable_response: 1 } } });
        expect(before.settledAttempts).toHaveLength(history === "settled" ? 1 : 0);
        expect(f.read().status).toBe("transport_failure");
        expect(await f.fill()).toMatchObject({ attempts: 1, terminal_failures: 1, newly_admitted: 0 });
        expect(readFileSync(f.ledgerPath).equals(bytes)).toBe(true);
        expect(await f.restart()).toMatchObject({ summary: { terminal_failures: 1, newly_admitted: 0 },
          statuses: ["transport_failure"] });
        expect(readFileSync(f.ledgerPath).equals(bytes)).toBe(true);
      }
    );

    it("retains native Gemini success bytes through proposal admission, reopen and no-call reuse", async () => {
      const cacheRoot = mkdtempSync(join(tmpdir(), "proposal-native-response-")); roots.push(cacheRoot);
      let calls = 0;
      let responseBody = "";
      const server = createServer(async (request, response) => {
        for await (const _chunk of request) { /* consume the complete request before responding */ }
        calls += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(responseBody);
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      try {
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const workset = { ...input.workset(), provider_url: origin };
        const line = materializeSemanticProposalLines(workset, 128)[0]!;
        const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 };
        responseBody = syntheticGeminiBody(input.body(line), "STOP", usage);
        const authority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(workset, cacheRoot, 128),
          inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
        const config = { ...input.config(), providerUrl: origin };
        expect(await executeSemanticProposalFill({ workset, cacheRoot, authority, config }))
          .toMatchObject({ attempts: 1, newly_admitted: 1 });
        expect(calls).toBe(1);
        expect(readProviderRawAttempt(cacheRoot, line.key, 1)).toMatchObject({
          response_body: { text: responseBody, truncated: false }, usage_known: true, usage
        });
        expect(readSemanticProposalResults(workset, cacheRoot, 128)[0]?.status).toBe("interpreted");
        expect(readSemanticChainProposalResults(workset, cacheRoot, 128)[0]?.received).toBeDefined();
        expect(openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: workset.kind }).snapshot())
          .toMatchObject({ unresolvedAttempts: [], telemetry: { totalTokens: 5 },
            settledAttempts: [{ attemptOrdinal: 1, usageSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) }] });
        await executeSemanticProposalFill({ workset, cacheRoot, authority, config: { ...config, apiKey: null } });
        expect(calls).toBe(1);
      } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });

    it.each(["missing", "truncated"] as const)("settles retained %s Gemini response evidence as incomplete without a provider call", async physical => {
      const f = fixture(); f.ledger.reserveAttemptOrdinal(f.line.key);
      const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 };
      f.raw(1, input.body(f.line), usage, physical);
      expect(f.read().status).toBe("pending");
      const beforeRaw = readFileSync(providerRawAttemptPath(f.cacheRoot, f.line.key, 1));
      const result = await f.fill();
      expect(result).toMatchObject({ attempts: 1, incomplete: 1, newly_admitted: 0, unknown: 0 });
      expect(f.read().status).toBe("incomplete");
      expect(f.chain().received).toBeUndefined();
      expect(readProviderRawAttempt(f.cacheRoot, f.line.key, 1)?.response_body?.truncated)
        .toBe(physical === "truncated" ? true : undefined);
      expect(readFileSync(providerRawAttemptPath(f.cacheRoot, f.line.key, 1)).equals(beforeRaw)).toBe(true);
      const settled = readFileSync(f.ledgerPath, "utf8");
      expect(JSON.parse(settled)).toMatchObject({ telemetry: { total_tokens: 5, usage_unavailable_requests: 0 },
        settled_attempts: [{ cache_key: f.line.key, attempt_ordinal: 1 }], successful_shards: [] });
      expect(await f.fill()).toMatchObject({ attempts: 0, cache_hits: 1, incomplete: 1, newly_admitted: 0 });
      expect(readFileSync(f.ledgerPath, "utf8")).toBe(settled);
    });

    it("refuses an admitted legacy shard whose retained Gemini response witness is absent", async () => {
      const f = fixture(); f.ledger.reserveAttemptOrdinal(f.line.key); f.raw(1, input.body(f.line));
      await f.fill();
      const path = providerRawAttemptPath(f.cacheRoot, f.line.key, 1);
      const raw = JSON.parse(readFileSync(path, "utf8")); delete raw.response_body;
      writeFileSync(path, JSON.stringify(raw));
      const ledger = readFileSync(f.ledgerPath, "utf8");
      expect(() => f.read()).toThrow(/proposal success differs/u);
      expect(f.chain()).toMatchObject({ status: "cache_invalid", received: undefined });
      expect(() => prepareSemanticProposal(f.workset, f.cacheRoot, 128)).toThrow();
      await expect(f.fill()).rejects.toThrow();
      expect(readFileSync(f.ledgerPath, "utf8")).toBe(ledger);
    });

    it.each(["body only", "body and normalized usage", "body and normalized usage without settlement witness"] as const)(
      "refuses admitted proposal after %s contradicts the retained attempt", async change => {
        const f = fixture(); f.ledger.reserveAttemptOrdinal(f.line.key);
        f.raw(1, input.body(f.line), { inputTokens: 2, outputTokens: 3, totalTokens: 5 });
        await f.fill();
        const rawPath = providerRawAttemptPath(f.cacheRoot, f.line.key, 1);
        const raw = JSON.parse(readFileSync(rawPath, "utf8"));
        const body = JSON.parse(raw.response_body.text);
        body.usageMetadata.promptTokenCount = 8;
        body.usageMetadata.totalTokenCount = 11;
        const text = JSON.stringify(body);
        raw.response_body = { ...raw.response_body, text, original_byte_length: Buffer.byteLength(text),
          digest: createHash("sha256").update(text).digest("hex") };
        if (change !== "body only") {
          raw.usage = { inputTokens: 8, outputTokens: 3, totalTokens: 11 };
          const shardPath = semanticProposalShardPath(f.cacheRoot, f.line.key);
          const shard = JSON.parse(readFileSync(shardPath, "utf8"));
          shard.usage = raw.usage;
          writeFileSync(shardPath, JSON.stringify(shard));
        }
        writeFileSync(rawPath, JSON.stringify(raw));
        if (change === "body and normalized usage without settlement witness") {
          const record = JSON.parse(readFileSync(f.ledgerPath, "utf8"));
          delete record.settled_attempts[0].usage_sha256;
          writeFileSync(f.ledgerPath, JSON.stringify(record));
        }
        const ledger = readFileSync(f.ledgerPath, "utf8");
        if (change === "body only") expect(() => readProviderRawAttempt(f.cacheRoot, f.line.key, 1))
          .toThrow(/physical response differs/u);
        else expect(readProviderRawAttempt(f.cacheRoot, f.line.key, 1)?.usage).toEqual(raw.usage);
        expect(() => f.read()).toThrow(change === "body only" ? /physical response differs/u :
          change === "body and normalized usage" ? /exact settled attempt/u : /exact settled usage witness/u);
        expect(f.chain()).toMatchObject({ status: "cache_invalid", received: undefined });
        expect(() => prepareSemanticProposal(f.workset, f.cacheRoot, 128)).toThrow();
        await expect(f.fill()).rejects.toThrow();
        expect(readFileSync(f.ledgerPath, "utf8")).toBe(ledger);
      }
    );

    it("keeps a settled response without its usage witness non-executable and never retries it", async () => {
      const f = fixture(); f.ledger.reserveAttemptOrdinal(f.line.key);
      f.raw(1, input.body(f.line), { inputTokens: 2, outputTokens: 3, totalTokens: 5 });
      f.ledger.recordTransportOutcome(f.line.key, { retryCount: 0, rateLimitRetries: 0,
        successfulRequestCount: 1, usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } }, 1);
      const record = JSON.parse(readFileSync(f.ledgerPath, "utf8"));
      delete record.settled_attempts[0].usage_sha256;
      writeFileSync(f.ledgerPath, JSON.stringify(record));
      const retained = readFileSync(f.ledgerPath, "utf8");
      expect(readProviderRawAttempt(f.cacheRoot, f.line.key, 1)?.usage?.totalTokens).toBe(5);
      expect(inspectExtractionAttemptLedger({ cacheRoot: f.cacheRoot,
        lineageDigest: f.authority.attempt_lineage_digest,
        cacheIdentity: { model: f.workset.model, requestProfile: input.config().requestProfile }
      })?.attempts).toBe(1);
      expect(inspectPopulationAttemptScopes([{ layer: f.workset.kind === "query" ? "query" : "correspondence",
        cacheRoot: f.cacheRoot, model: f.workset.model, requestProfile: f.workset.request_profile,
        keys: [f.line.key] }])).toMatchObject({ scoped_authorized_attempts: 1,
        observed_raw_receipts: 1, observed_known_usage_attempts: 1, scoped_reported_input_tokens: 2 });
      expect(() => f.read()).toThrow(/exact settled usage witness/u);
      expect(f.chain()).toMatchObject({ status: "cache_invalid", received: undefined });
      let calls = 0;
      await expect(executeSemanticProposalFill({ workset: f.workset, cacheRoot: f.cacheRoot,
        authority: f.authority, config: input.config(), extractor: { extract: async () => {
          calls += 1; throw new Error("must not retry");
        } } })).rejects.toThrow(/exact settled usage witness/u);
      expect(calls).toBe(0);
      expect(readFileSync(f.ledgerPath, "utf8")).toBe(retained);
    });

    it("refuses an admitted shard after its settled usage witness is removed", async () => {
      const f = fixture(); f.ledger.reserveAttemptOrdinal(f.line.key);
      f.raw(1, input.body(f.line), { inputTokens: 2, outputTokens: 3, totalTokens: 5 });
      await f.fill();
      const record = JSON.parse(readFileSync(f.ledgerPath, "utf8"));
      delete record.settled_attempts[0].usage_sha256;
      writeFileSync(f.ledgerPath, JSON.stringify(record));
      const retained = readFileSync(f.ledgerPath, "utf8");
      expect(() => f.read()).toThrow(/exact settled usage witness/u);
      expect(f.chain()).toMatchObject({ status: "cache_invalid", received: undefined });
      expect(() => openSemanticProposalAttemptLedger({ cacheRoot: f.cacheRoot,
        authority: f.authority, kind: f.workset.kind })).toThrow(/exact settled usage witness/u);
      await expect(f.fill()).rejects.toThrow(/exact settled usage witness/u);
      expect(readFileSync(f.ledgerPath, "utf8")).toBe(retained);
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
      expect(f.read().status).toBe("incomplete");
      expect(await f.fill()).toMatchObject({ unknown: 0, incomplete: 1, unattempted: 0, newly_admitted: 0 });
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
          calls += 1; const rawJson = input.body(f.line);
          return { rawJson, responseMetadata: { finishReason: "STOP" },
            responseBody: syntheticGeminiBody(rawJson, "STOP") };
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
      expect(settled.settledAttempts).toMatchObject([{ cacheKey: f.line.key, attemptOrdinal: 1,
        usageSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) }]);
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
