import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: openMock
  };
});

const { execShell } = await import("../../mcp/tool-runtime-file-write-exec.js");

describe("execShell containment failures", () => {
  let root: string;
  let commandPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tool-exec-root-"));
    commandPath = join(root, "run.sh");
    writeFileSync(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(commandPath, 0o755);
    openMock.mockReset();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("maps ENOSPC during open to a non-ACCESS_DENIED error and redacts paths in warnings", async () => {
    const enospc = new Error(`ENOSPC: no space left on device, open '${commandPath}'`) as NodeJS.ErrnoException;
    enospc.code = "ENOSPC";
    openMock.mockRejectedValue(enospc);
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => process);

    const result = (await execShell({ command: commandPath } as never, [root])) as {
      ok: boolean;
      code?: string;
    };

    expect(result.ok).toBe(false);
    expect(result.code).toBe("READ_ERROR");
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining("exec containment open failed"),
      expect.objectContaining({
        code: "ALAYA_EXEC_CONTAINMENT_FAILED",
        detail: JSON.stringify({ operation: "open", errno: "ENOSPC" })
      })
    );

    emitWarning.mockRestore();
  });

  it("returns ACCESS_DENIED for containment violations without leaking paths in warnings", async () => {
    const eacces = new Error(`EACCES: permission denied, open '${commandPath}'`) as NodeJS.ErrnoException;
    eacces.code = "EACCES";
    openMock.mockRejectedValue(eacces);
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => process);

    const result = (await execShell({ command: commandPath } as never, [root])) as {
      ok: boolean;
      code?: string;
      message?: string;
    };

    expect(result.ok).toBe(false);
    expect(result.code).toBe("ACCESS_DENIED");
    const warningDetail = emitWarning.mock.calls[0]?.[1] as { detail?: string } | undefined;
    expect(warningDetail?.detail).not.toContain(commandPath);
    expect(JSON.parse(warningDetail?.detail ?? "{}")).toEqual({ operation: "open", errno: "EACCES" });

    emitWarning.mockRestore();
  });
});
