import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ALAYA_SYSEXITS, createAlayaCliBridge } from "../../cli/bridge.js";
import {
  createTemporalCutoverCommandSpec,
  type TemporalCutoverCommandDependencies
} from "../../cli/temporal-cutover.js";

function createTextSink(): { readonly stream: PassThrough; readonly readText: () => string } {
  const stream = new PassThrough();
  let text = "";
  stream.on("data", (chunk) => {
    text += chunk.toString("utf8");
  });
  return { stream, readText: () => text };
}

function createHarness(options: {
  readonly shutdown: () => Promise<void>;
  readonly cutOver?: TemporalCutoverCommandDependencies["cutOver"];
  readonly rollback?: TemporalCutoverCommandDependencies["rollback"];
  readonly recover?: TemporalCutoverCommandDependencies["recover"];
}) {
  const stdout = createTextSink();
  const stderr = createTextSink();
  const bridge = createAlayaCliBridge(
    { startupSteps: [{ step: "http-app", completedAt: "2026-07-17T00:00:00.000Z" }] },
    {
      env: { ALAYA_CONFIG_DIR: "/tmp/alaya-temporal-cli" },
      stdin: new PassThrough(),
      stdout: stdout.stream,
      stderr: stderr.stream,
      isTTY: false
    }
  );
  bridge.registerSubcommand(createTemporalCutoverCommandSpec(
    { shutdown: options.shutdown },
    { cutOver: options.cutOver, rollback: options.rollback, recover: options.recover }
  ));
  return { bridge, stdout, stderr };
}

describe("temporal cutover CLI", () => {
  it("requires explicit confirmation before it stops the runtime", async () => {
    const shutdown = vi.fn(async () => undefined);
    const { bridge, stderr } = createHarness({ shutdown });

    const result = await bridge.dispatch([
      "temporal-cutover",
      "cutover",
      "candidate.db",
      "receipt.json",
      "journal.json",
      "--reason",
      "operator review"
    ]);

    expect(result).toEqual({ exitCode: ALAYA_SYSEXITS.USAGE });
    expect(shutdown).not.toHaveBeenCalled();
    expect(stderr.readText()).toContain("requires --yes");
  });

  it("stops the runtime before invoking the pointer cutover and returns its result", async () => {
    const order: string[] = [];
    const shutdown = vi.fn(async () => {
      order.push("shutdown");
    });
    const cutOver = vi.fn(async (input: Parameters<NonNullable<TemporalCutoverCommandDependencies["cutOver"]>>[0]) => {
      order.push("cutover");
      expect(input).toMatchObject({
        configPaths: { tomlPath: path.join("/tmp/alaya-temporal-cli", "alaya.toml") },
        candidateFilename: "candidate.db",
        candidateReceiptFilename: "receipt.json",
        journalFilename: "journal.json",
        reason: "operator review"
      });
      return {
        status: "committed" as const,
        journalFilename: "journal.json",
        candidateFilename: "candidate.db",
        selectionId: "00000000-0000-4000-8000-000000000001"
      };
    });
    const { bridge, stdout } = createHarness({ shutdown, cutOver });

    const result = await bridge.dispatch([
      "temporal-cutover",
      "--json",
      "cutover",
      "candidate.db",
      "receipt.json",
      "journal.json",
      "--reason",
      "operator review",
      "--yes"
    ]);

    expect(result).toMatchObject({ exitCode: ALAYA_SYSEXITS.OK, json: { status: "committed" } });
    expect(order).toEqual(["shutdown", "cutover"]);
    expect(stdout.readText()).toContain('"status":"committed"');
  });

  it("uses the same stopped-runtime barrier for journal recovery", async () => {
    const order: string[] = [];
    const shutdown = vi.fn(async () => {
      order.push("shutdown");
    });
    const recover = vi.fn(async (input: Parameters<NonNullable<TemporalCutoverCommandDependencies["recover"]>>[0]) => {
      order.push("recover");
      expect(input).toEqual({ journalFilename: "journal.json", reason: "recovery" });
      return { status: "rolled_back" as const, journalFilename: "journal.json" };
    });
    const { bridge } = createHarness({ shutdown, recover });

    const result = await bridge.dispatch([
      "temporal-cutover",
      "recover",
      "journal.json",
      "--reason",
      "recovery",
      "--yes"
    ]);

    expect(result).toMatchObject({ exitCode: ALAYA_SYSEXITS.OK, json: { status: "rolled_back" } });
    expect(order).toEqual(["shutdown", "recover"]);
  });
});
