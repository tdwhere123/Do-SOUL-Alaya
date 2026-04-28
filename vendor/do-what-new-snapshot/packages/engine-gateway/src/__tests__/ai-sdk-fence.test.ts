import { readFile } from "node:fs/promises";
import * as publicApi from "@do-what/engine-gateway";
import { describe, expect, it } from "vitest";

describe("engine-gateway AI SDK helper fence", () => {
  it("does not expose internal AI SDK helpers from the public package API", () => {
    expect("buildMessages" in publicApi).toBe(false);
    expect("mapFinishReason" in publicApi).toBe(false);
    expect("nonStreamingTools" in publicApi).toBe(false);
  });

  it("defines a package exports map that does not expose internal provider helpers", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8")
    ) as {
      readonly exports?: Record<string, unknown>;
    };

    expect(packageJson.exports).toBeDefined();
    expect(packageJson.exports).toHaveProperty(".");
    expect(packageJson.exports).not.toHaveProperty("./provider/internal/*");
    expect(packageJson.exports).not.toHaveProperty("./src/provider/internal/*");
    expect(packageJson.exports).not.toHaveProperty("./provider/ai-sdk-non-streaming");
  });
});
