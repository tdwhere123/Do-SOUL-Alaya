// @ts-nocheck
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
  OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE,
  OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT
} from "@do-soul/alaya-soul";
import { QUERY_SEMANTIC_FACTOR_FILL_IDENTITY_SCHEMA_VERSION,
  queryCachePrefixedSha256
} from "../../../bench/query-factors/query-semantic-factor-cache-identity.js";
import { queryCacheSourceSetDigest } from
  "../../../bench/query-factors/cache/source-set.js";
import { openQuerySemanticFactorFillStore } from
  "../../../bench/query-factors/query-semantic-factor-fill-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("query semantic factor fill identity", () => {
  it("fail-closes an obsolete request profile instead of binding it as current", async () => {
    const root = await tempRoot();
    const outputPath = join(root, "query-cache.json");
    await expect(openQuerySemanticFactorFillStore({
      outputPath,
      identity: fillIdentity("deepseek-v4-nonthinking-v1") as never
    })).rejects.toThrow();

    const persisted = join(`${outputPath}.partial`, "identity.json");
    await mkdir(dirname(persisted), { recursive: true });
    await writeFile(persisted, `${JSON.stringify(fillIdentity("deepseek-v4-nonthinking-v1"))}\n`);
    await expect(openQuerySemanticFactorFillStore({
      outputPath,
      identity: fillIdentity("provider-default-v1")
    })).rejects.toThrow();
  });
});

function fillIdentity(requestProfile: string) {
  return {
    schema_version: QUERY_SEMANTIC_FACTOR_FILL_IDENTITY_SCHEMA_VERSION,
    compiler_operator_id: OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
    request_profile: requestProfile,
    system_prompt_sha256: queryCachePrefixedSha256(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT),
    request_template_sha256: queryCachePrefixedSha256(
      OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE
    ),
    model_id: "test-model",
    provider_url_sha256: queryCachePrefixedSha256("https://provider.invalid/v1"),
    source_set_sha256: queryCacheSourceSetDigest(["What did I buy?"])
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "query-cache-fill-identity-"));
  roots.push(root);
  return root;
}
