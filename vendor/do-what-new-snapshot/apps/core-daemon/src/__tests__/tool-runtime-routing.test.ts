import { afterEach, describe, expect, it } from "vitest";
import { getToolRuntimeWiringFixture, resetToolRuntimeWiringState } from "./tool-runtime-wiring-fixture.js";

const hoisted = getToolRuntimeWiringFixture();

describe("daemon tool runtime routing", () => {
  afterEach(() => {
    resetToolRuntimeWiringState();
  });

  it("rejects invalid tools.read_file input before calling the engine-gateway tool", async () => {
    await import("../index.js");

    const result = await hoisted.mcpBridgeDeps!.toolsHandler!(
      {
        type: "tool_use",
        id: "toolu-2",
        name: "tools.read_file",
        input: {}
      },
      {
        workspace_id: "workspace-1",
        run_id: "run-1",
        surface_id: null,
        user_message_id: "msg-user-1",
        assistant_message_id: "msg-assistant-1"
      }
    );

    expect(hoisted.readFile).not.toHaveBeenCalled();
    expect(hoisted.toolHotPathExecute).not.toHaveBeenCalled();
    expect(result.is_error).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      error: expect.stringContaining("Invalid input for tools.read_file")
    });
  });

  it("rejects invalid tools.write_file input before calling the engine-gateway tool", async () => {
    await import("../index.js");

    const result = await hoisted.mcpBridgeDeps!.toolsHandler!(
      {
        type: "tool_use",
        id: "toolu-6",
        name: "tools.write_file",
        input: {
          path: "/workspace/project/notes.txt"
        }
      },
      {
        workspace_id: "workspace-1",
        run_id: "run-1",
        surface_id: null,
        user_message_id: "msg-user-1",
        assistant_message_id: "msg-assistant-1"
      }
    );

    expect(hoisted.writeFile).not.toHaveBeenCalled();
    expect(hoisted.toolHotPathExecute).not.toHaveBeenCalled();
    expect(result.is_error).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      error: expect.stringContaining("Invalid input for tools.write_file")
    });
  });

  it("rejects invalid tools.exec_shell input before calling the core conversation tool executor", async () => {
    await import("../index.js");

    const result = await hoisted.mcpBridgeDeps!.toolsHandler!(
      {
        type: "tool_use",
        id: "toolu-8",
        name: "tools.exec_shell",
        input: {
          command: "",
          args: ["hello"]
        }
      },
      {
        workspace_id: "workspace-1",
        run_id: "run-1",
        surface_id: null,
        user_message_id: "msg-user-1",
        assistant_message_id: "msg-assistant-1"
      }
    );

    expect(hoisted.execShell).not.toHaveBeenCalled();
    expect(hoisted.toolHotPathExecute).not.toHaveBeenCalled();
    expect(result.is_error).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      error: expect.stringContaining("Invalid input for tools.exec_shell")
    });
  });

  it("returns structured tool errors for write_file results", async () => {
    hoisted.writeFile.mockResolvedValueOnce({
      ok: false,
      code: "WRITE_ERROR",
      message: "disk full"
    });

    await import("../index.js");

    const result = await hoisted.mcpBridgeDeps!.toolsHandler!(
      {
        type: "tool_use",
        id: "toolu-9",
        name: "tools.write_file",
        input: {
          path: "/workspace/project/notes.txt",
          content: "hello"
        }
      },
      {
        workspace_id: "workspace-1",
        run_id: "run-1",
        surface_id: null,
        user_message_id: "msg-user-1",
        assistant_message_id: "msg-assistant-1"
      }
    );

    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu-9",
      content: JSON.stringify({
        ok: false,
        code: "WRITE_ERROR",
        message: "disk full"
      }),
      is_error: true
    });
  });

  it("rejects invalid tools.read_file results before returning them to the bridge", async () => {
    hoisted.readFile.mockResolvedValueOnce({
      ok: true,
      content: "hello"
    });

    await import("../index.js");

    const result = await hoisted.mcpBridgeDeps!.toolsHandler!(
      {
        type: "tool_use",
        id: "toolu-3",
        name: "tools.read_file",
        input: {
          path: "/workspace/project/README.md"
        }
      },
      {
        workspace_id: "workspace-1",
        run_id: "run-1",
        surface_id: null,
        user_message_id: "msg-user-1",
        assistant_message_id: "msg-assistant-1"
      }
    );

    expect(hoisted.readFile).toHaveBeenCalledWith(
      {
        path: "/workspace/project/README.md"
      },
      ["/workspace/project"]
    );
    expect(result.is_error).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      error: expect.stringContaining("Invalid result for tools.read_file")
    });
  });

  it("rejects invalid tools.exec_shell results before returning them to the bridge", async () => {
    hoisted.execShell.mockResolvedValueOnce({
      ok: true,
      stdout: "ok\n",
      stderr: ""
    });

    await import("../index.js");

    const result = await hoisted.mcpBridgeDeps!.toolsHandler!(
      {
        type: "tool_use",
        id: "toolu-7",
        name: "tools.exec_shell",
        input: {
          command: "echo",
          args: ["hello"]
        }
      },
      {
        workspace_id: "workspace-1",
        run_id: "run-1",
        surface_id: null,
        user_message_id: "msg-user-1",
        assistant_message_id: "msg-assistant-1"
      }
    );

    expect(hoisted.execShell).toHaveBeenCalledWith(
      {
        command: "echo",
        args: ["hello"]
      },
      ["/workspace/project"]
    );
    expect(result.is_error).toBe(true);
    expect(JSON.parse(result.content)).toEqual({
      error: expect.stringContaining("Invalid result for tools.exec_shell")
    });
  });
});
