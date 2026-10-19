import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runBatchCampaignCommand } from "../../../cli/extraction-fill/campaign-command.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runManifest(manifestPath: string): Promise<{ code: number; stderr: string }> {
  const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    return {
      code: await runBatchCampaignCommand(["--batch-campaign", manifestPath]),
      stderr: write.mock.calls.map(([chunk]) => String(chunk)).join("")
    };
  } finally {
    write.mockRestore();
  }
}

// A malformed or missing manifest fails the campaign prologue, so no fill
// dispatch, provider call, or window-state publication can happen here.
it.each([
  { label: "malformed", contents: "{not json", category: "campaign_artifact_invalid_json" },
  { label: "missing", contents: undefined, category: "campaign_artifact_access_failed" }
] as const)("names a $label manifest as a bounded pre-publication failure", async ({ contents, category }) => {
  const root = await mkdtemp(join(tmpdir(), "campaign-command-"));
  roots.push(root);
  const manifestPath = join(root, "campaign.json");
  if (contents !== undefined) await writeFile(manifestPath, contents);

  const result = await runManifest(manifestPath);

  expect(result.code).toBe(2);
  expect(result.stderr).toContain(`Batch campaign stopped: ${category}`);
  expect(result.stderr).toContain("may predate any published window state");
  expect(result.stderr).not.toContain("inspect its manifest and current window state");
  expect(existsSync(join(root, ".batch-campaign", "state.json"))).toBe(false);
});
