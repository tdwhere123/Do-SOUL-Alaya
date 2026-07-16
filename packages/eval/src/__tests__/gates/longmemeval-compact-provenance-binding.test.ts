import { describe, expect, it } from "vitest";
import { MergedRunProvenanceBindingSchema } from
  "../../gates/longmemeval-provenance-schemas.js";
import {
  compactFixture,
  verify
} from "./longmemeval-provenance-fixture.js";

describe("merged compact extraction authority binding", () => {
  it("accepts 32 compact shards from one parent over exact [0,500)", () => {
    const fixture = compactFixture();

    expect(() => verify(fixture)).not.toThrow();
    expect(fixture.artifacts.filter((item) =>
      item.role === "fanout_authority"
    )).toHaveLength(1);
    expect(fixture.artifacts.filter((item) =>
      item.role === "shard_extraction_authority_ref"
    )).toHaveLength(32);
    expect(fixture.provenance.shards.at(-1)?.execution).toMatchObject({
      offset: 485,
      limit: 15
    });
  });

  it("rejects refs when either parent authority is missing or replaced", () => {
    const missing = compactFixture();
    missing.artifacts = missing.artifacts.filter((item) =>
      item.role !== "fanout_authority"
    );
    expect(() => verify(missing)).toThrow(/incomplete parent authority/u);

    const replaced = compactFixture();
    const index = replaced.artifacts.findIndex((item) =>
      item.role === "extraction_authority"
    );
    replaced.artifacts[index] = {
      ...replaced.artifacts[index]!,
      contents: `${JSON.stringify({ replaced: true })}\n`
    };
    expect(() => verify(replaced)).toThrow(/differs from descriptor/u);
  });

  it("does not gate compact children without authority hydration", () => {
    const fixture = compactFixture();
    fixture.provenance = MergedRunProvenanceBindingSchema.parse({
      ...fixture.provenance,
      extraction_authority: null,
      fanout_authority: null,
      shards: fixture.provenance.shards.map((shard) => ({
        ...shard,
        extraction_authority_ref_filename: null,
        extraction_authority_ref_sha256: null
      }))
    });
    fixture.artifacts = fixture.artifacts.filter((item) =>
      item.role !== "extraction_authority" && item.role !== "fanout_authority" &&
      item.role !== "shard_extraction_authority_ref"
    );

    expect(() => verify(fixture)).toThrow(/parent authorit/u);
  });

  it("rejects a 32-shard parent plan outside exact [0,500)", () => {
    const fixture = compactFixture(1);

    expect(() => verify(fixture)).toThrow(/exact \[0,500\)/u);
  });

  it("rejects aggregate shard indices outside canonical array order", () => {
    const fixture = compactFixture();
    fixture.provenance.shards[0] = {
      ...fixture.provenance.shards[0]!,
      shard_index: 1
    };

    expect(() => verify(fixture)).toThrow(/canonical shard order/u);
  });
});
