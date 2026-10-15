import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetCjkSegmentationStateForTests,
  __setCjkSegmentationLoaderForTests,
  readCjkSegmentationStatus,
  segmentCjkRun,
  warmCjkSegmentation
} from "@do-soul/alaya-cjk-segmentation";
import type { SourceIndexLexicalRead } from "@do-soul/alaya-protocol";
import {
  QUERY_BUDGET, WORKSPACE, fixture, type Fixture
} from "./source-index-query-fixture.js";

const environments: Fixture[] = [];
beforeEach(() => {
  __resetCjkSegmentationStateForTests();
});
afterEach(() => {
  for (const environment of environments.splice(0)) environment.database.close();
  __resetCjkSegmentationStateForTests();
  vi.restoreAllMocks();
});
function setup() {
  const environment = fixture();
  environments.push(environment);
  return environment;
}
function lexical(environment: Fixture, query: string) {
  return environment.index.readLexicalCandidates(WORKSPACE, query, 8, QUERY_BUDGET);
}

/** Contract field order is canonical code-unit key order, not insertion or helper output. */
function frameLexicalBinding(tokenization: NonNullable<SourceIndexLexicalRead["tokenization"]>): string {
  return `{${[
    ["cjk_state", JSON.stringify(tokenization.cjk_state)],
    ["policy", JSON.stringify(tokenization.policy)],
    ["terms", JSON.stringify([...tokenization.terms])],
    ["trigram_terms", JSON.stringify([...tokenization.trigram_terms])],
    ["unicode61_terms", JSON.stringify([...tokenization.unicode61_terms])]
  ].map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(",")}}`;
}
function independentDigest(preimage: string): string {
  return `sha256:${createHash("sha256").update(preimage, "utf8").digest("hex")}`;
}

describe("source index lexical tokenization provenance", () => {
  it("does not initialize a cold loader, keeps uninitialized state, and binds terms not navigation text", () => {
    let loads = 0;
    __setCjkSegmentationLoaderForTests(async () => {
      loads += 1;
      return { cut: (input: string) => [input] };
    });
    const environment = setup();
    const query = "部署";
    expect(readCjkSegmentationStatus()).toBe("uninitialized");
    const read = lexical(environment, query);
    expect(readCjkSegmentationStatus()).toBe("uninitialized");
    expect(loads).toBe(0);
    expect("navigation_digest" in read).toBe(false);
    expect(read.tokenization).toMatchObject({
      policy: "source-index-fts.v1",
      cjk_state: "uninitialized",
      terms: ["部署"],
      unicode61_terms: ["部署"],
      trigram_terms: []
    });
    const tokenization = read.tokenization!;
    expect(tokenization.binding_digest).toBe(independentDigest(frameLexicalBinding(tokenization)));
    expect(tokenization.binding_digest).not.toBe(independentDigest(query));
    expect(tokenization.binding_digest).not.toBe(independentDigest(JSON.stringify(query)));
  });

  it("leaves an already-loading segmenter in loading and reports that captured state", () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    let loads = 0;
    __setCjkSegmentationLoaderForTests(() => {
      loads += 1;
      return new Promise(() => undefined);
    });
    expect(segmentCjkRun("我喜欢咖啡")).toEqual(["我喜欢咖啡"]);
    expect(readCjkSegmentationStatus()).toBe("loading");
    expect(loads).toBe(1);
    const read = lexical(setup(), "部署");
    expect(readCjkSegmentationStatus()).toBe("loading");
    expect(loads).toBe(1);
    expect(read.tokenization).toMatchObject({
      policy: "source-index-fts.v1",
      cjk_state: "loading",
      terms: ["部署"],
      unicode61_terms: ["部署"],
      trigram_terms: []
    });
    expect("navigation_digest" in read).toBe(false);
  });

  it("reports unavailable provenance without starting another load", async () => {
    let loads = 0;
    __setCjkSegmentationLoaderForTests(async () => {
      loads += 1;
      return null;
    });
    await expect(warmCjkSegmentation()).resolves.toBe(false);
    expect(readCjkSegmentationStatus()).toBe("unavailable");
    expect(loads).toBe(1);
    const read = lexical(setup(), "部署");
    expect(readCjkSegmentationStatus()).toBe("unavailable");
    expect(loads).toBe(1);
    expect(read.tokenization).toMatchObject({
      policy: "source-index-fts.v1",
      cjk_state: "unavailable",
      terms: ["部署"],
      unicode61_terms: ["部署"],
      trigram_terms: []
    });
  });

  it("retains warm pieces in exact and lane terms without replacing the binding digest framing", async () => {
    __setCjkSegmentationLoaderForTests(async () => ({
      cut: (input: string) => input === "我喜欢咖啡" ? ["我", "喜欢", "咖啡"] : [input]
    }));
    await expect(warmCjkSegmentation()).resolves.toBe(true);
    expect(readCjkSegmentationStatus()).toBe("ready");
    const query = "我喜欢咖啡";
    const read = lexical(setup(), query);
    expect(readCjkSegmentationStatus()).toBe("ready");
    expect(read.tokenization).toMatchObject({
      policy: "source-index-fts.v1",
      cjk_state: "ready",
      terms: ["我喜欢咖啡", "喜欢", "咖啡"],
      unicode61_terms: ["喜欢", "咖啡"],
      trigram_terms: ["我喜欢咖啡"]
    });
    const tokenization = read.tokenization!;
    expect(tokenization.binding_digest).toBe(independentDigest(frameLexicalBinding(tokenization)));
    expect(tokenization.binding_digest).not.toBe(independentDigest(query));
    expect("navigation_digest" in read).toBe(false);
  });
});
