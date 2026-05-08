import { describe, expect, it, vi } from "vitest";
import {
  CustomApiGardenProvider,
  GardenProviderError,
  GardenProviderKind,
  LocalModelGardenProvider,
  OfficialApiGardenProvider
} from "../garden/compute-provider.js";

describe("OfficialApiGardenProvider", () => {
  it("materializes candidate signals from a successful official API response", async () => {
    const fetchImpl = vi.fn(async () =>
      createJsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                signals: [
                  {
                    signal_kind: "potential_preference",
                    object_kind: "user_preference",
                    confidence: 0.92,
                    matched_text: "Call me Ash",
                    reason: "naming_preference"
                  }
                ]
              })
            }
          }
        ]
      })
    );
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      fetchImpl,
      now: () => "2026-04-23T09:00:00.000Z",
      generateSignalId: () => "signal-1"
    });

    await expect(provider.compile("Call me Ash.", createContext())).resolves.toEqual([
      expect.objectContaining({
        signal_id: "signal-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        source: "garden_compile",
        signal_kind: "potential_preference",
        object_kind: "user_preference",
        confidence: 0.92,
        raw_payload: expect.objectContaining({
          matched_text: "Call me Ash",
          provider_kind: GardenProviderKind.OFFICIAL_API,
          extraction_reason: "naming_preference"
        }),
        created_at: "2026-04-23T09:00:00.000Z"
      })
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("accepts OpenAI-compatible base URLs and posts to chat completions", async () => {
    const seenUrls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      seenUrls.push(String(input));
      return createJsonResponse({ choices: [{ message: { content: JSON.stringify({ signals: [] }) } }] });
    });
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      endpoint: "https://garden.example.test/v1/",
      fetchImpl
    });

    await expect(provider.compile("No durable memory here.", createContext())).resolves.toEqual([]);

    expect(seenUrls).toEqual(["https://garden.example.test/v1/chat/completions"]);
  });

  it("keeps full chat completions endpoints unchanged", async () => {
    const seenUrls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      seenUrls.push(String(input));
      return createJsonResponse({ choices: [{ message: { content: JSON.stringify({ signals: [] }) } }] });
    });
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      endpoint: "https://garden.example.test/v1/chat/completions",
      fetchImpl
    });

    await expect(provider.compile("No durable memory here.", createContext())).resolves.toEqual([]);

    expect(seenUrls).toEqual(["https://garden.example.test/v1/chat/completions"]);
  });

  it("fails closed when official provider credentials are missing", async () => {
    const fetchImpl = vi.fn();
    const provider = new OfficialApiGardenProvider({
      fetchImpl
    });

    await expect(provider.compile("Call me Ash.", createContext())).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "auth",
      message: "Official garden provider credentials are missing."
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces upstream provider failures with their typed error kind", async () => {
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      fetchImpl: vi.fn(async () => new Response("upstream failure", { status: 503 }))
    });

    await expect(provider.compile("Call me Ash.", createContext())).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "provider_failure",
      message: "Official garden provider request failed with status 503."
    } satisfies Partial<GardenProviderError>);
  });

  it("surfaces timed out official API requests as network errors with the timeout message", async () => {
    const clearTimeoutImpl = vi.fn();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(true);
      throw new Error("request aborted");
    });
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      requestTimeoutMs: 321,
      fetchImpl,
      createAbortController: () => new AbortController(),
      setTimeoutImpl: ((callback: Parameters<typeof setTimeout>[0]) => {
        if (typeof callback === "function") {
          callback();
        }
        return 1 as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeoutImpl: clearTimeoutImpl as typeof clearTimeout
    });

    await expect(provider.compile("Call me Ash.", createContext())).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "network",
      message: "Official garden provider request timed out after 321ms."
    } satisfies Partial<GardenProviderError>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(clearTimeoutImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid official API payloads", async () => {
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      fetchImpl: vi.fn(async () =>
        createJsonResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  signals: "not-an-array"
                })
              }
            }
          ]
        })
      )
    });

    await expect(provider.compile("Call me Ash.", createContext())).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "invalid_response",
      message: "Official garden provider returned an invalid response."
    } satisfies Partial<GardenProviderError>);
  });

  it("surfaces the custom API stub as a typed provider failure", async () => {
    const provider = new CustomApiGardenProvider();

    await expect(provider.compile()).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "provider_failure",
      message: "CustomApiGardenProvider is not implemented in Phase 0.5."
    } satisfies Partial<GardenProviderError>);
  });

  it("surfaces the local model stub as a typed provider failure", async () => {
    const provider = new LocalModelGardenProvider();

    await expect(provider.compile()).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "provider_failure",
      message: "LocalModelGardenProvider is not implemented in Phase 0.5."
    } satisfies Partial<GardenProviderError>);
  });
});

function createContext() {
  return {
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: "surface-1",
    turn_messages: [
      {
        role: "user" as const,
        content: "Call me Ash.",
        message_id: "message-1",
        created_at: "2026-04-23T09:00:00.000Z"
      }
    ]
  };
}

function createJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}
