import { readFile } from "node:fs/promises";
import { OfficialApiGardenProvider } from "@do-soul/alaya-soul";
import { createGardenHttpExtractor } from
  "../dist/bench/compile-seed/compile-seed-http.js";
import { resolveCompileSeedExtractionConfig } from
  "../dist/bench/compile-seed/compile-seed-config.js";
import { fillQuerySemanticFactorSources } from
  "../dist/bench/query-factors/query-semantic-factor-cache.js";
import { resolveExtractionTransportRoute } from
  "../dist/bench/extraction/transport-route.js";
import { EXTRACTION_REQUEST_TIMEOUT_MS } from
  "../dist/bench/compile-seed/http/output-token-retry.js";

const questionsPath = process.argv[2];
const outputPath = process.argv[3];
if (questionsPath === undefined || outputPath === undefined) {
  throw new Error("usage: fill-query-factors.mjs <questions.json> <output.json>");
}

const questions = JSON.parse(await readFile(questionsPath, "utf8"));
const sourceTexts = [...new Set(questions.map((row) => {
  if (typeof row?.question !== "string" || row.question.length === 0) {
    throw new Error("questions.json entries must include a non-empty question");
  }
  return row.question;
}))];

const config = resolveCompileSeedExtractionConfig(process.env);
if (config.apiKey === null) {
  throw new Error("query semantic factor cache fill requires a resolved garden API key");
}

const provider = new OfficialApiGardenProvider({
  apiKey: config.apiKey,
  model: config.model,
  endpoint: config.providerUrl,
  extractor: createGardenHttpExtractor(config),
  requestTimeoutMs: EXTRACTION_REQUEST_TIMEOUT_MS,
  diagnosticDir: null
});

const started = Date.now();
const binding = await fillQuerySemanticFactorSources({
  source_texts: sourceTexts,
  output_path: outputPath,
  model_id: config.model,
  provider_url: config.providerUrl,
  transport: resolveExtractionTransportRoute(config),
  concurrency: 8,
  compile: async (sourceText, obligation) =>
    await provider.extractCertifiedQueryOpenSemanticFactors(sourceText, obligation),
  log: (message) => {
    process.stdout.write(`${message}\n`);
  }
});

process.stdout.write(`${JSON.stringify({
  ok: true,
  elapsed_ms: Date.now() - started,
  output_path: outputPath,
  source_count: sourceTexts.length,
  binding
}, null, 2)}\n`);
