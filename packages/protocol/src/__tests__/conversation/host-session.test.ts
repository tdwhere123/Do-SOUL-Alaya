import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  HOST_SESSION_CONTRACT,
  HostSessionCaptureRequestSchema,
  HostSessionCaptureResponseSchema,
  hostSessionContainerKey,
  hostSessionRoundSourceId,
  hostSessionStatementSessionId,
  pairHostSessionRounds
} from "../../conversation/host-session.js";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const container = { scope: "chat", id: "thread-1" };
const message = (message_id: string, position: number, role: "user" | "assistant", extras = {}) => ({
  message_id, position, role, content: "hello", completeness: "complete" as const,
  fidelity: "original_bytes" as const, ...extras
});

it("pairs a following non-user reply, keeps a trailing user pending, and names the round from the container", () => {
  expect(HOST_SESSION_CONTRACT).toBe("host-session-v1");
  expect(pairHostSessionRounds([
    { role: "user", position: 0 }, { role: "assistant", position: 1 }, { role: "assistant", position: 2 }
  ], false)).toEqual({ rounds: [[0, 1], [2]], pendingFrom: null });
  expect(pairHostSessionRounds([{ role: "user", position: 0 }], false)).toEqual({ rounds: [], pendingFrom: 0 });
  expect(pairHostSessionRounds([{ role: "user", position: 0 }], true)).toEqual({ rounds: [[0]], pendingFrom: null });
  const key = hostSessionContainerKey(container, sha256);
  expect(hostSessionStatementSessionId(key)).toBe(`host-session:${key}`);
  expect(hostSessionRoundSourceId(key, 0)).toBe(`host-session:${key}:r0`);
});

it("admits capture requests with source-bound dependencies and echoes version-bound message sources", () => {
  const dependency = { source_id: "source", root_id: "root", source_version: "1",
    content_digest: `sha256:${"a".repeat(64)}`, occurrence_id: "occ-1" };
  expect(HostSessionCaptureRequestSchema.parse({
    container, messages: [message("m1", 0, "user", { semantic_dependencies: [dependency] })]
  }).messages[0]?.semantic_dependencies).toEqual([dependency]);
  expect(HostSessionCaptureRequestSchema.safeParse({
    container, messages: [message("m1", 0, "user"), message("m1", 1, "assistant")]
  }).success).toBe(false);
  expect(HostSessionCaptureResponseSchema.parse({
    container_key: "key", admitted_message_count: 1, replayed_message_count: 0, pending_message_count: 0,
    admitted_round_count: 1, pending_round_count: 0, message_sources: [{ message_id: "m1", source: dependency }]
  }).message_sources).toHaveLength(1);
});
