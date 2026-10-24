import { join } from "node:path";

const fixtureRoot = process.env.EXTRACTION_FILL_FIXTURE_ROOT;
const mode = process.env.EXTRACTION_FILL_FIXTURE_MODE;
if (fixtureRoot === undefined || mode === undefined) {
  throw new Error("extraction-fill subprocess fixture environment is incomplete");
}

// Own synthetic credentials after pre-import isolation, never inherit an operator key.
process.env.ALAYA_OFFICIAL_GARDEN_SECRET_REF = "env:E0_SUBPROCESS_GARDEN_KEY";
process.env.E0_SUBPROCESS_GARDEN_KEY = "test-key";

// Requires a fresh pnpm build, as CI performs; use the actual runtime without a second compiler.
const runtimeRoot = new URL("../../../../dist/", import.meta.url);
const fill = await import(new URL("runs/extraction/extraction-fill.js", runtimeRoot));
const cli = await import(new URL("cli/extraction-fill/command-core.js", runtimeRoot));
const authorityInspection = await import(new URL("runs/extraction/authority/inspection.js", runtimeRoot));
const authorityReceipt = await import(new URL("runs/extraction/authority/receipt.js", runtimeRoot));
const inspection = await authorityInspection.inspectExtractionAuthority({
  variant: "longmemeval_oracle",
  cacheRoot: join(fixtureRoot, "cache"),
  dataDir: join(fixtureRoot, "data"),
  pinnedMetaRoot: join(fixtureRoot, "pinned"),
  revision: authorityInspection.readCurrentExtractionAuthorityRevision(),
  action: "fill"
});
const receiptPath = join(fixtureRoot, "extraction-authority.json");
authorityReceipt.writeExtractionAuthorityReceipt(receiptPath,
  authorityReceipt.createExtractionAuthorityReceipt({
    action: "fill",
    observation: inspection.observation,
    outputTokenCap: { field: "max_tokens", value: 512 },
    priceEstimate: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      maximumInputTokensPerAttempt: 100_000
    },
    diskFloorBytes: 0,
    inspection: {
      writerLock: inspection.writerLock,
      disk: inspection.disk,
      credentialStatus: inspection.credentialStatus,
      modelReadiness: inspection.modelReadiness
    }
  })
);
const exitCode = await cli.runExtractionFillCommand(
  {
    variant: "longmemeval_oracle",
    concurrency: 2,
    extractionAuthority: receiptPath
  },
  {
    signalSource: process,
    runExtractionFill: (options) => fill.runExtractionFill({
      ...options,
      cacheRoot: join(fixtureRoot, "cache"),
      dataDir: join(fixtureRoot, "data"),
      pinnedMetaRoot: join(fixtureRoot, "pinned"),
      extractorFactory: () => createFixtureExtractor(mode)
    })
  }
);
process.exitCode = exitCode;
process.stdout.write("FIXTURE_SETTLED\n");

function createFixtureExtractor(fixtureMode) {
  let calls = 0;
  let releasePeer;
  const peerStarted = new Promise((resolve) => {
    releasePeer = resolve;
  });
  return {
    extract: async (input) => {
      calls += 1;
      input.onTransportAttempt?.();
      if (fixtureMode === "terminal" && calls === 1) {
        for (let retry = 0; retry < 3; retry += 1) input.onTransportAttempt?.();
        await peerStarted;
        const error = new Error("sk-fixture-secret PROMPT_BODY");
        error.benchRetry = {
          retryCount: 3,
          retryClassification: "failure_non_retryable_4xx",
          rateLimitRetries: 0,
          transportFailures: Array.from({ length: 4 }, (_value, index) => ({
            kind: "http_error",
            phase: "response_status",
            httpStatus: 400,
            fingerprint: "a".repeat(64),
            attempt: index + 1
          }))
        };
        throw error;
      }
      releasePeer();
      process.stdout.write("FIXTURE_READY\n");
      if (fixtureMode === "terminal") await waitForLeaseObservation();
      return waitForAbort(input.abortSignal, () => {
        process.stdout.write("FIXTURE_ARMED\n");
      });
    }
  };
}

async function waitForLeaseObservation() {
  process.stdin.setEncoding("utf8");
  let received = "";
  for await (const chunk of process.stdin) {
    received += chunk;
    if (received.includes("LEASE_OBSERVED")) return;
  }
  throw new Error("fixture parent closed before observing the extraction lease");
}

function waitForAbort(signal, onArmed) {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(
      () => {
        reject(new Error("fixture peer was not cooperatively aborted"));
      },
      2_000
    );
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
    onArmed();
  });
}
