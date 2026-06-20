import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listEntries,
  readLatest,
  writeEntry,
  type HistoryLayout
} from "../../history/history.js";
import {
  buildLivePayload,
  buildPayload} from "./history-fixture.js";

describe("history archive", () => {
  let layout: HistoryLayout;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "bench-history-"));
    layout = { historyRoot: root };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it("allows mixed live-gates sidecars with status pass and at least one passing source gate", async () => {
    const mixedSlug = "2026-05-15T160000Z-c0ffee3";

    await writeEntry(
      layout,
      "live",
      mixedSlug,
      buildLivePayload("c0ffee3"),
      "report\n",
      null,
      {
        sidecars: [
          {
            filename: "live-gates.json",
            contents: JSON.stringify({
              latest_run_id: "run-1",
              status: "pass",
              gates: [
                { id: "provider_top5", pass: true },
                { id: "optional_latency_budget", pass: false }
              ]
            }) + "\n"
          }
        ]
      }
    );

    expect(
      JSON.parse(await readFile(path.join(root, "live", "latest-passing.json"), "utf8")).slug
    ).toBe(mixedSlug);
    expect((await readLatest(layout, "live", { pointerKind: "passing" }))?.alaya_commit)
      .toBe("c0ffee3");
  });


  it("rejects live-gates sidecars with status pass but zero passing source gates", async () => {
    const blockedSlug = "2026-05-15T170000Z-c0ffee4";

    await writeEntry(
      layout,
      "live",
      blockedSlug,
      buildLivePayload("c0ffee4"),
      "report\n",
      null,
      {
        sidecars: [
          {
            filename: "live-gates.json",
            contents: JSON.stringify({
              latest_run_id: "run-1",
              status: "pass",
              gates: [
                { id: "provider_top5", pass: false },
                { id: "optional_latency_budget", pass: false }
              ]
            }) + "\n"
          }
        ]
      }
    );

    await expect(
      readFile(path.join(root, "live", "latest-passing.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readLatest(layout, "live", { pointerKind: "passing" })).toBeNull();
  });

  // @anchor orphan-staging-filter-test: see history.ts @write-entry-tmp-filter.
  // If a writeEntry is killed (SIGKILL / OOM) between mkdtemp and rename,
  // the .tmp-<slug>-<rand>/ staging directory is left on disk with a
  // parseable kpi.json. listEntries / readLatest must NOT return it.

  it("ignores orphan .tmp- staging directories left by interrupted writes", async () => {
    // Simulate an orphan staging dir matching the prefix we use.
    const orphanDir = path.join(
      root,
      "self",
      ".tmp-2026-05-14T999999Z-aaaaaaa-x7r2qp"
    );
    await mkdir(orphanDir, { recursive: true });
    await writeFile(
      path.join(orphanDir, "kpi.json"),
      JSON.stringify(buildPayload("aaaaaaa"), null, 2) + "\n",
      "utf8"
    );
    await writeFile(path.join(orphanDir, "report.md"), "orphan\n", "utf8");

    // Plus a real entry alongside.
    await writeEntry(
      layout,
      "self",
      "2026-05-14T100000Z-bbbbbbb",
      buildPayload("bbbbbbb"),
      "real\n",
      null
    );

    const slugs = await listEntries(layout, "self");
    expect(slugs).toEqual(["2026-05-14T100000Z-bbbbbbb"]);
    const latest = await readLatest(layout, "self");
    expect(latest?.alaya_commit).toBe("bbbbbbb");
  });

});
