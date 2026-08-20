import { SoulReviewMemoryProposalResponseSchema } from "@do-soul/alaya-protocol";
import type { CreateBenchSeedOpsInput } from "./daemon-seed-ops-types.js";

interface BenchSeedProposalReviewerInput {
  readonly activeContext: { readonly workspaceId: string; readonly runId: string };
  readonly dispatchCli: (
    argv: readonly string[]
  ) => Promise<{ readonly exitCode: number; readonly json?: unknown }>;
  readonly reviewerIdentity: string;
}

export function createBenchSeedProposalReviewer(
  input: BenchSeedProposalReviewerInput
): CreateBenchSeedOpsInput["reviewMemoryProposal"] {
  return async (review) => {
    const result = await input.dispatchCli([
      "review",
      "accept",
      review.proposalId,
      "--reviewer",
      input.reviewerIdentity,
      "--reason",
      review.reason,
      "--workspace",
      input.activeContext.workspaceId,
      "--run",
      input.activeContext.runId,
      "--json"
    ]);
    if (result.exitCode !== 0) {
      throw new Error(formatCliReviewFailure(result.exitCode, result.json));
    }
    return SoulReviewMemoryProposalResponseSchema.parse(result.json);
  };
}

function formatCliReviewFailure(exitCode: number, payload: unknown): string {
  const prefix = `alaya review accept failed with exitCode=${exitCode}`;
  const detail = readCliReviewFailureDetail(payload);
  return detail === null ? prefix : `${prefix}: ${detail}`;
}

function readCliReviewFailureDetail(payload: unknown): string | null {
  if (!isRecord(payload) || payload.ok !== false || !isRecord(payload.error)) {
    return null;
  }
  const code = payload.error.code;
  const message = payload.error.message;
  if (
    typeof code !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ||
    typeof message !== "string"
  ) {
    return null;
  }
  const sanitizedMessage = message
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim()
    .slice(0, 512);
  return sanitizedMessage.length === 0 ? null : `${code}: ${sanitizedMessage}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
