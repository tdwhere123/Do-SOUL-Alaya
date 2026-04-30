import type { Hono } from "hono";
import { CoreError, type ProposalService, type WorkspaceService } from "@do-soul/alaya-core";

export interface ProposalRouteServices {
  readonly workspaceService: WorkspaceService;
  readonly proposalService: ProposalService;
}

export function registerProposalRoutes(app: Hono, services: ProposalRouteServices): void {
  app.get("/workspaces/:wsId/proposals", async (context) => {
    const workspaceId = context.req.param("wsId");
    await services.workspaceService.getById(workspaceId);

    const state = context.req.query("state");
    const proposals =
      state === "all"
        ? await services.proposalService.findByWorkspaceId(workspaceId)
        : await services.proposalService.findPending(workspaceId);

    return context.json({ success: true, data: proposals }, 200);
  });

  app.get("/proposals/:id", async (context) => {
    const proposal = await services.proposalService.findById(context.req.param("id"));

    if (proposal === null) {
      throw new CoreError("NOT_FOUND", "Proposal not found");
    }

    return context.json({ success: true, data: proposal }, 200);
  });

  app.post("/proposals/:id/review", async (context) => {
    const proposalId = context.req.param("id");
    const body = await parseReviewBody(context.req.json.bind(context.req));
    const reviewedBy =
      normalizeReviewerId(context.req.header("x-reviewer-id")) ??
      normalizeReviewerId(body.reviewed_by) ??
      "user";

    const updated = await services.proposalService.review(proposalId, {
      action: body.action,
      note: body.note,
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString()
    });

    return context.json({ success: true, data: updated }, 200);
  });
}

async function parseReviewBody(readJson: () => Promise< unknown>): Promise<{
  readonly action: "accepted" | "rejected";
  readonly note: string | null;
  readonly reviewed_by: string | null;
}> {
  let body: unknown;

  try {
    body = await readJson();
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid request body", { cause: error });
  }

  if (body === null || typeof body !== "object") {
    throw new CoreError("VALIDATION", "Review request body must be an object");
  }

  const candidate = body as {
    readonly action?: unknown;
    readonly note?: unknown;
    readonly reviewed_by?: unknown;
  };

  if (candidate.action !== "accepted" && candidate.action !== "rejected") {
    throw new CoreError("VALIDATION", "Review action must be accepted or rejected");
  }

  if (candidate.note !== undefined && candidate.note !== null && typeof candidate.note !== "string") {
    throw new CoreError("VALIDATION", "Review note must be a string when provided");
  }

  if (
    candidate.reviewed_by !== undefined &&
    candidate.reviewed_by !== null &&
    typeof candidate.reviewed_by !== "string"
  ) {
    throw new CoreError("VALIDATION", "reviewed_by must be a string when provided");
  }

  return {
    action: candidate.action,
    note: normalizeNullableNote(candidate.note),
    reviewed_by: normalizeReviewerId(candidate.reviewed_by)
  };
}

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

const normalizeNullableNote = normalizeNullableString;
const normalizeReviewerId = normalizeNullableString;
