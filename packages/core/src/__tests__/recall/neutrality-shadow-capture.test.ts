import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  YOGA_OBJECT_ID,
  YOGA_QUERY,
  runYogaNeutralityBundle
} from "./neutrality-shadow-fixture.js";

describe("identity-bound yoga neutrality capture", () => {
  it("records a provider miss then a suppressed cache hit", async () => {
    const bundle = await runYogaNeutralityBundle();
    const out = process.env.NEUTRALITY_CAPTURE_OUT;
    if (out !== undefined && out.length > 0) {
      writeFileSync(out, `${JSON.stringify(bundle)}\n`);
    }
    expect(bundle.miss.membership).toEqual([YOGA_OBJECT_ID]);
    expect(bundle.hit.membership).toEqual([YOGA_OBJECT_ID]);
    expect(bundle.miss.order).toEqual(bundle.miss.membership);
    expect(bundle.hit.order).toEqual(bundle.hit.membership);
    expect(bundle.miss.trace.provider_embed_texts.length).toBeGreaterThan(0);
    expect(bundle.miss.trace.provider_embed_texts.some((call) =>
      call.texts.includes(YOGA_QUERY)
    )).toBe(true);
    expect(bundle.hit.trace.provider_embed_texts).toEqual([]);
    expect(bundle.miss.trace.repo_reads.length).toBeGreaterThan(0);
    expect(bundle.hit.trace.repo_reads.length).toBeGreaterThan(0);
    expect(bundle.miss.trace.repo_writes).toEqual([]);
    expect(bundle.hit.trace.repo_writes).toEqual([]);
  });
});
