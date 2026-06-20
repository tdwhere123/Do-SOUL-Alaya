import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GardenProviderError,
  GardenProviderKind,
  OfficialApiGardenProvider
} from "../../garden/compute-provider.js";
import {
  SignalExtractorError,
  type SignalExtractor,
  type SignalExtractorMeta
} from "../../garden/pi-mono-extractor.js";

import { createContext } from "./compute-provider-fixtures.js";

describe("OfficialApiGardenProvider diagnostic dump (Phase A.1 instrument)", () => {
  let diagnosticDir: string;

  beforeEach(() => {
    diagnosticDir = mkdtempSync(join(tmpdir(), "garden-diagnostic-"));
  });

  afterEach(() => {
    rmSync(diagnosticDir, { recursive: true, force: true });
  });

  it("dumps a diagnostic envelope when the model returns a malformed signals shape", async () => {
    const extractor: SignalExtractor = {
      extract: vi.fn(async () => ({ rawJson: '{"not_signals":[]}' }))
    };
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      model: "gpt-test-mini",
      endpoint: "https://example.test/v1",
      extractor,
      diagnosticDir,
      now: () => "2026-05-27T12:00:00.000Z"
    });

    // The original failure must still propagate — instrument is observation.
    await expect(
      provider.compile("Call me Ash.", createContext())
    ).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "invalid_response"
    } satisfies Partial<GardenProviderError>);

    const files = readdirSync(diagnosticDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const dump = JSON.parse(
      readFileSync(join(diagnosticDir, files[0]!), "utf8")
    ) as Record<string, unknown>;

    // Schema must carry every field a Phase A.2 preflight reader expects.
    expect(dump).toMatchObject({
      captured_at: "2026-05-27T12:00:00.000Z",
      provider_kind: GardenProviderKind.OFFICIAL_API,
      model_id: "gpt-test-mini",
      endpoint: "https://example.test/v1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      surface_id: "surface-1",
      response_body_total_chars: 18
    });
    expect(typeof dump.response_body_prefix).toBe("string");
    expect((dump.response_body_prefix as string).startsWith('{"not_signals"')).toBe(true);
    expect(typeof dump.user_prompt_prefix).toBe("string");
    expect((dump.user_prompt_prefix as string).length).toBeLessThanOrEqual(512);
  });

  it("dumps a diagnostic envelope when the extractor reports invalid_json", async () => {
    const extractor: SignalExtractor = {
      extract: vi.fn(async () => {
        throw new SignalExtractorError(
          "invalid_json",
          "Signal extractor returned no text content."
        );
      })
    };
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      model: "gpt-test-mini",
      extractor,
      diagnosticDir,
      now: () => "2026-05-27T12:30:00.000Z"
    });

    await expect(
      provider.compile("Call me Ash.", createContext())
    ).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "invalid_response"
    } satisfies Partial<GardenProviderError>);

    const files = readdirSync(diagnosticDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const dump = JSON.parse(
      readFileSync(join(diagnosticDir, files[0]!), "utf8")
    ) as Record<string, unknown>;
    expect(dump.signal_extractor_error).toMatchObject({
      is_signal_extractor_error: true,
      kind: "invalid_json",
      name: "SignalExtractorError"
    });
    // No raw body was captured because the extractor threw before returning.
    expect(dump.response_body_prefix).toBeNull();
    expect(dump.response_body_total_chars).toBeNull();
  });

  it("surfaces extractorMeta (recovery_kind, retry_count) on the dump envelope", async () => {
    // Provider got valid extractorMeta from a recovered+retried extract call,
    // but the body shape (signals key) was still wrong — invalid_response.
    const extractor: SignalExtractor = {
      extract: vi.fn(async () => ({
        rawJson: '{"not_signals":[]}',
        extractorMeta: { recoveryKind: "markdown_strip", retryCount: 1 } as SignalExtractorMeta
      }))
    };
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      model: "gpt-test-mini",
      extractor,
      diagnosticDir,
      now: () => "2026-05-27T13:00:00.000Z"
    });
    await expect(
      provider.compile("Call me Ash.", createContext())
    ).rejects.toMatchObject({ name: "GardenProviderError", kind: "invalid_response" });
    const files = readdirSync(diagnosticDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const dump = JSON.parse(readFileSync(join(diagnosticDir, files[0]!), "utf8")) as Record<string, unknown>;
    expect(dump.recovery_kind).toBe("markdown_strip");
    expect(dump.extractor_retry_count).toBe(1);
  });

  it("surfaces SignalExtractorError.retryCount on the dump envelope when extract threw", async () => {
    const extractor: SignalExtractor = {
      extract: vi.fn(async () => {
        throw new SignalExtractorError(
          "invalid_json",
          "Signal extractor returned no text content.",
          { retryCount: 1 }
        );
      })
    };
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      model: "gpt-test-mini",
      extractor,
      diagnosticDir,
      now: () => "2026-05-27T13:30:00.000Z"
    });
    await expect(
      provider.compile("Call me Ash.", createContext())
    ).rejects.toMatchObject({ name: "GardenProviderError", kind: "invalid_response" });
    const files = readdirSync(diagnosticDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const dump = JSON.parse(readFileSync(join(diagnosticDir, files[0]!), "utf8")) as Record<string, unknown>;
    expect(dump.extractor_retry_count).toBe(1);
    // No extractorMeta because extract() threw before returning — recovery_kind
    // defaults to "none" so the dump shape stays stable for readers.
    expect(dump.recovery_kind).toBe("none");
  });

  it("does not dump when diagnosticDir is explicitly null and skips network errors", async () => {
    // diagnosticDir: null — instrument disabled, fs untouched.
    const nullDirProvider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: { extract: vi.fn(async () => ({ rawJson: '{"not_signals":[]}' })) },
      diagnosticDir: null
    });
    await expect(
      nullDirProvider.compile("Call me Ash.", createContext())
    ).rejects.toMatchObject({ name: "GardenProviderError", kind: "invalid_response" });
    // diagnosticDir untouched (still empty from beforeEach).
    expect(readdirSync(diagnosticDir).filter((f) => f.endsWith(".json"))).toHaveLength(0);

    // Network/timeout errors are NOT invalid_response — no dump expected.
    const timeoutProvider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: {
        extract: vi.fn(async () => {
          throw new SignalExtractorError("timeout", "Signal extractor request timed out.");
        })
      },
      diagnosticDir
    });
    await expect(
      timeoutProvider.compile("Call me Ash.", createContext())
    ).rejects.toMatchObject({ name: "GardenProviderError", kind: "network" });
    expect(readdirSync(diagnosticDir).filter((f) => f.endsWith(".json"))).toHaveLength(0);
  });

  // invariant: wall-clock outer guard fires when the inner extractor never
  // resolves — the host-suspend hang root cause. The fetch promise never
  // resolves, the SDK's monotonic setTimeout is also paused, and only the
  // outer wall-clock check rescues the call.
  // see also: packages/soul/src/garden/wall-clock-timeout.ts
  it("aborts a hanging extractor via the outer wall-clock guard and classifies as network", async () => {
    const hangingExtractor: SignalExtractor = {
      extract: vi.fn<SignalExtractor["extract"]>(
        (input) =>
          new Promise<Awaited<ReturnType<SignalExtractor["extract"]>>>((_, reject) => {
            if (input.abortSignal?.aborted === true) {
              reject(new Error("aborted-by-wall-clock"));
              return;
            }
            input.abortSignal?.addEventListener("abort", () => {
              reject(new Error("aborted-by-wall-clock"));
            });
          })
      )
    };
    // Short wallClockBudgetMs override (test seam) so the test does not wait
    // the production 30s grace; wall-clock-only behaviour is covered by
    // wall-clock-timeout.test.ts.
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: hangingExtractor,
      requestTimeoutMs: 10_000,
      wallClockBudgetMs: 100,
      diagnosticDir: null
    });
    await expect(
      provider.compile("Call me Ash.", createContext())
    ).rejects.toMatchObject({ name: "GardenProviderError", kind: "network" });
    expect(hangingExtractor.extract).toHaveBeenCalledTimes(1);
  });
});
