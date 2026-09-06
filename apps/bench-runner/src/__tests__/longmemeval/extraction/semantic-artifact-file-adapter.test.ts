import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSemanticArtifactRepository } from
  "../../../runs/extraction/cache/semantic-artifact/file-adapter.js";
import type { AdmittedSemanticArtifact, SemanticEnrichmentTask } from "@do-soul/alaya-protocol";

describe("file semantic artifact adapter", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("persists an admitted artifact under the historical run root and refuses scheduling APIs", () => {
    const root = mkdtempSync(join(tmpdir(), "semantic-file-adapter-"));
    directories.push(root);
    const repo = new FileSemanticArtifactRepository(root);
    const task = {
      id: "source_enrich_fixture", workspaceId: "ws", objectId: "obj", revision: "rev",
      profile: {
        capability: "official_api_signals:v1", model: "fixture", requestProfile: "logical-request-v1",
        promptRevision: "prompt", outputSchema: "official-api-signals-v1"
      },
      status: "claimed", claim: "in-process", claimedAt: "2026-05-31T12:00:00.000Z", attempts: 1
    } satisfies SemanticEnrichmentTask;
    const artifact: AdmittedSemanticArtifact = {
      key: "a".repeat(64),
      rawJson: JSON.stringify({ signals: [{ object_kind: "decision" }] }),
      payloadJson: JSON.stringify([{ object_kind: "decision", matched_text: "Alice owns Orion" }]),
      searchText: "Alice owns Orion\ndecision"
    };
    repo.put(task, artifact);
    expect(repo.artifact("ws", artifact.key)).toEqual(artifact);
    expect(repo.artifact("other", artifact.key)).toBeNull();
    expect(() => repo.claim(task, "token", task.claimedAt!)).toThrow(/does not implement claim/);
  });
});
