import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { AlayaCliContext } from "../../cli/bridge.js";
import {
  buildInspectorChildEnv,
  createInspectCommand,
  type InspectorChildProcess,
  type SpawnInspectorInput
} from "../../cli/inspect/inspect.js";
import {
  defaultInspectorEntryPath,
  defaultSpawnInspector
} from "../../cli/inspect/inspect-child-process.js";
import { INSPECTOR_LAUNCH_CODE_ENV } from "../../cli/inspect/inspect-constants.js";
import { resolveReviewerIdentity } from "../../mcp-memory/proposal/reviewer-gating.js";

const REVIEWER_TOKEN = "handoff-reviewer-token";
const REVIEWER_IDENTITY = "user:local-reviewer";
const PAYLOAD_IDENTITY = "user:payload-override";

class FakeInspectorChild extends EventEmitter implements InspectorChildProcess {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();

  public kill(): boolean {
    return true;
  }
}

describe("inspect reviewer binding handoff", () => {
  it("forwards the configured reviewer binding to the inspector child and nothing else", async () => {
    let spawned: SpawnInspectorInput | undefined;
    const child = new FakeInspectorChild();
    const command = createInspectCommand({
      checkPortAvailable: async () => true,
      spawnInspector: (input) => {
        spawned = input;
        return child;
      },
      listWorkspaces: oneWorkspaceList()
    });

    const promise = command.handler(
      createContext({
        env: {
          ALAYA_DAEMON_URL: "http://127.0.0.1:5173",
          ALAYA_REVIEWER_TOKEN: ` ${REVIEWER_TOKEN} `,
          ALAYA_REVIEWER_IDENTITY: ` ${REVIEWER_IDENTITY} `,
          OPENAI_API_KEY: "sk-secret",
          [INSPECTOR_LAUNCH_CODE_ENV]: "parent-launch-code"
        }
      }),
      { open: false, port: 5174, token: null, workspace: null }
    );
    setTimeout(() => child.stdout.write("inspector_ready\n"), 0);
    setTimeout(() => child.emit("exit", 0, null), 10);

    expect((await promise).exitCode).toBe(0);
    expect(spawned?.env).toEqual({
      ALAYA_DAEMON_URL: "http://127.0.0.1:5173",
      ALAYA_REVIEWER_TOKEN: REVIEWER_TOKEN,
      ALAYA_REVIEWER_IDENTITY: REVIEWER_IDENTITY
    });
    expect(Object.keys(buildInspectorChildEnv(spawned!)).sort()).toEqual([
      "ALAYA_DAEMON_URL",
      "ALAYA_INSPECTOR_PORT",
      "ALAYA_INSPECTOR_WORKSPACE_ID",
      "ALAYA_REVIEWER_IDENTITY",
      "ALAYA_REVIEWER_TOKEN"
    ]);
  });

  it("carries the configured binding through the real inspector child to a protected review", async () => {
    const reviews: unknown[] = [];
    const daemon = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      reviews.push(body);
      try {
        resolveReviewerIdentity(body, { token: REVIEWER_TOKEN, identity: REVIEWER_IDENTITY });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ success: true, data: { ok: true } }));
      } catch {
        response.writeHead(400);
        response.end();
      }
    });
    const daemonOrigin = await listen(daemon);
    const inspectorPort = await freeLoopbackPort();
    const output: string[] = [];
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdout.on("data", (chunk) => output.push(String(chunk)));
    stderr.on("data", (chunk) => output.push(String(chunk)));
    let child: InspectorChildProcess | undefined;
    const handlerPromise = createInspectCommand({
      checkPortAvailable: async () => true,
      inspectorEntryPath: defaultInspectorEntryPath(),
      spawnInspector: (input) => {
        child = defaultSpawnInspector(input);
        return child;
      },
      listWorkspaces: oneWorkspaceList()
    }).handler(
      createContext({
        env: {
          ALAYA_DAEMON_URL: daemonOrigin,
          ALAYA_REVIEWER_TOKEN: REVIEWER_TOKEN,
          ALAYA_REVIEWER_IDENTITY: REVIEWER_IDENTITY
        },
        stdout,
        stderr
      }),
      { open: false, port: inspectorPort, token: null, workspace: null }
    );

    try {
      const launchUrl = await waitForLaunchUrl(() => output.join(""), inspectorPort);
      expect(launchUrl).toBe(`http://127.0.0.1:${inspectorPort}/?workspaceId=ws-1`);
      const html = await fetch(launchUrl);
      expect(html.status).toBe(200);
      const session = /alaya_inspector_session=[^;]+/u.exec(
        html.headers.getSetCookie().join("; ")
      )?.[0];
      if (session === undefined) {
        throw new Error("inspector session cookie missing");
      }
      const review = await fetch(
        `http://127.0.0.1:${inspectorPort}/api/proposals/ws-1/prop-1/review`,
        {
          method: "POST",
          headers: { "content-type": "application/json", cookie: session },
          body: JSON.stringify({
            verdict: "accept",
            reason: "looks right",
            reviewer_identity: PAYLOAD_IDENTITY
          })
        }
      );
      expect(review.status).toBe(200);
      expect(reviews).toEqual([
        {
          verdict: "accept",
          reason: "looks right",
          reviewer_identity: REVIEWER_IDENTITY,
          reviewer_token: REVIEWER_TOKEN
        }
      ]);
      expect(output.join("")).not.toContain(REVIEWER_TOKEN);
    } finally {
      child?.kill("SIGTERM");
      await handlerPromise;
      await close(daemon);
    }
  });
});

function createContext(overrides: Partial<AlayaCliContext> = {}): AlayaCliContext {
  return {
    cwd: "/tmp",
    env: {},
    argv: [],
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    isTTY: false,
    daemon: { startupSteps: [] },
    ...overrides
  };
}

function oneWorkspaceList() {
  return async () => [
    {
      workspace_id: "ws-1",
      name: "Sample",
      repo_path: "/tmp/sample",
      workspace_state: "active"
    }
  ];
}

async function waitForLaunchUrl(output: () => string, port: number): Promise<string> {
  const expected = `http://127.0.0.1:${port}/?workspaceId=ws-1`;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (output().includes(expected)) {
      return expected;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`inspector launch URL was not printed: ${output()}`);
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("loopback port expected"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function freeLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("loopback port expected");
  }
  const { port } = address;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}
