import { isAbsolute } from "node:path";
import { z } from "zod";
import { AlayaError } from "@do-soul/alaya-protocol";
import { decodeCanonicalUtf8Artifact, readBoundedStableRegularFile } from "../../extraction/cache-audit/bounded-artifact-reader.js";
import type { TextMcpProviderSessionGrant } from "./session-authority.js";

export const TextMcpSessionTerminalSchema = z.object({
  key: z.string(), request_digest: z.string(), lineage: z.string(), ordinal: z.number().int().positive(),
  raw_json: z.string(), admitted: z.boolean(), outcome: z.unknown(), finish_reason: z.string().nullable(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), totalTokens: z.number() }).optional()
}).strict();
export const TEXT_MCP_SESSION_TERMINAL_MAX_BYTES = 8 * 1024 * 1024;

export function readSharedInitialTurn(shared: NonNullable<TextMcpProviderSessionGrant["shared_initial_turn1"]>) {
  const { path, sha256 } = shared.turn_pin;
  if (!isAbsolute(path)) throw new AlayaError("CONFLICT", "shared initial turn path must be absolute");
  const label = "shared initial provider session turn";
  const file = readBoundedStableRegularFile({ path, maxBytes: TEXT_MCP_SESSION_TERMINAL_MAX_BYTES, label });
  if (file.identity.sha256 !== sha256) throw new AlayaError("CONFLICT", "shared initial turn pin mismatch");
  const turn = TextMcpSessionTerminalSchema.parse(JSON.parse(decodeCanonicalUtf8Artifact(file.bytes, label)));
  if (!turn.admitted || turn.ordinal !== 1 || turn.request_digest !== shared.request_digest) {
    throw new AlayaError("CONFLICT", "shared initial turn must be admitted at ordinal one with the granted request digest");
  }
  return turn;
}
