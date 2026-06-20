import { vi } from "vitest";
import type { SignalExtractor } from "../../garden/pi-mono-extractor.js";

export function createContext() {
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

export function createExtractor(rawJson: string): SignalExtractor {
  return {
    extract: vi.fn(async () => ({ rawJson }))
  };
}
