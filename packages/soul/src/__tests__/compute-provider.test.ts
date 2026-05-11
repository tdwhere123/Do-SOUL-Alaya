import { describe, expect, it, vi } from "vitest";
import {
  CustomApiGardenProvider,
  GardenProviderError,
  GardenProviderKind,
  LocalModelGardenProvider,
  OfficialApiGardenProvider
} from "../garden/compute-provider.js";
import { SignalExtractorError, type SignalExtractor } from "../garden/pi-mono-extractor.js";

describe("OfficialApiGardenProvider", () => {
  it("materializes candidate signals from a successful official API response", async () => {
    const extractor = createExtractor(JSON.stringify({
      signals: [
        {
          signal_kind: "potential_preference",
          object_kind: "user_preference",
          confidence: 0.92,
          matched_text: "Call me Ash",
          reason: "naming_preference"
        }
      ]
    }));
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor,
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
    expect(extractor.extract).toHaveBeenCalledTimes(1);
  });

  it("passes structured turn content to the signal extractor", async () => {
    const extractor = createExtractor(JSON.stringify({ signals: [] }));
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor
    });

    await expect(provider.compile("No durable memory here.", createContext())).resolves.toEqual([]);

    expect(JSON.parse(vi.mocked(extractor.extract).mock.calls[0]![0].userPrompt)).toMatchObject({
      workspace_id: "workspace-1",
      run_id: "run-1",
      surface_id: "surface-1",
      turn_content: "No durable memory here."
    });
  });

  it("fails closed when official provider credentials are missing", async () => {
    const extractor = createExtractor(JSON.stringify({ signals: [] }));
    const provider = new OfficialApiGardenProvider({
      extractor
    });

    await expect(provider.compile("Call me Ash.", createContext())).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "auth",
      message: "Official garden provider credentials are missing."
    });
    expect(extractor.extract).not.toHaveBeenCalled();
  });

  it("surfaces extractor transport failures as network errors", async () => {
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: {
        extract: vi.fn(async () => {
          throw new SignalExtractorError("transport_failure", "Signal extractor request failed.");
        })
      }
    });

    await expect(provider.compile("Call me Ash.", createContext())).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "network",
      message: "Signal extractor request failed."
    } satisfies Partial<GardenProviderError>);
  });

  it("surfaces timed out extractor requests as network errors with the timeout message", async () => {
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      requestTimeoutMs: 321,
      extractor: {
        extract: vi.fn(async () => {
          throw new SignalExtractorError("timeout", "Signal extractor request timed out after 321ms.");
        })
      }
    });

    await expect(provider.compile("Call me Ash.", createContext())).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "network",
      message: "Signal extractor request timed out after 321ms."
    } satisfies Partial<GardenProviderError>);
  });

  it("rejects invalid official API payloads", async () => {
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(JSON.stringify({
        signals: "not-an-array"
      }))
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

function createExtractor(rawJson: string): SignalExtractor {
  return {
    extract: vi.fn(async () => ({ rawJson }))
  };
}
