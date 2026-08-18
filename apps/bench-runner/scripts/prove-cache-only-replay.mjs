import { readFileSync } from "node:fs";
import { proveProviderZeroCallReplay } from
  "../dist/bench/provider/replay-proof.js";

const keys = readFileSync(process.argv[2], "utf8")
  .split(/\s+/u)
  .filter((key) => key.length > 0);
const limit = Number(process.argv[8] ?? "1");
const offset = Number(process.argv[9] ?? "0");
const proof = proveProviderZeroCallReplay({
  request: {
    datasetRevision: process.argv[3],
    requestedKeys: keys,
    providerRoute: process.argv[10] ?? "https://opencode.ai/zen/go/v1",
    model: process.argv[11] ?? "mimo-v2.5",
    requestProfile: process.argv[12] ?? "mimo-v2.5-nonthinking-v1",
    promptDigest: process.argv[4],
    schemaDigest: process.argv[5],
    operatorDigest: process.argv[6],
    cacheMode: "cache_only",
    variant: "longmemeval_s",
    limit,
    offset,
    worker: false,
    extractionCacheRoot: process.argv[7]
  }
});
process.stdout.write(
  `Done. full-window replay physical_calls=${proof.physical_calls} ` +
    `profile=${proof.profile} keys=${keys.length}\n`
);
