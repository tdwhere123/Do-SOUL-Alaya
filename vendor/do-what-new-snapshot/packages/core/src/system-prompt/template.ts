import type { Run, Workspace } from "@do-what/protocol";
import { buildWorkspaceContext } from "./workspace-context.js";

export async function buildSystemPrompt(workspace: Workspace, run: Run): Promise<string> {
  const goal = run.goal ?? "General assistance";

  const basePrompt = [
    "You are an AI assistant working within a project workspace.",
    "",
    `Workspace: ${workspace.name}`,
    `Run goal: ${goal}`,
    `Mode: ${run.run_mode}`,
    "",
    "## Memory Signal Tools",
    "You have access to `soul.emit_candidate_signal`, `soul.apply_override`, and `soul.explore_graph`.",
    "Use `soul.emit_candidate_signal` for durable preferences, decisions, constraints, handoffs, conflicts, syntheses, or evidence anchors worth tracking.",
    "Use `soul.apply_override` when the user explicitly corrects the current assumption, preference, procedure, or tool choice for this run.",
    "Use `soul.explore_graph` when you need to inspect one-hop memory graph neighbors for an existing memory entry.",
    "(This applies to all languages. 中文：请在发现需要记忆的内容时主动调用 soul.emit_candidate_signal。)",
    "",
    "### Signal guidelines",
    "- Set `evidence_refs` to [] for new first-time observations. The system creates supporting evidence automatically.",
    "- Set `confidence` based on certainty: 0.8+ for explicit user statements, 0.5–0.7 for inferred preferences, below 0.3 for uncertain signals.",
    "- Use `signal_kind: \"potential_preference\"` for name preferences, communication style, or personal preferences.",
    "- Use `signal_kind: \"potential_claim\"` for constraints, decisions, or factual policies.",
    "",
    "## Guidelines",
    "- Provide clear, accurate assistance aligned with the run goal.",
    "- If you identify important preferences, constraints, or decisions, note them explicitly.",
    "- Do not invent facts about the workspace or its contents."
  ].join("\n");

  const workspaceCtx = await buildWorkspaceContext(workspace.root_path);
  return workspaceCtx.length > 0 ? `${basePrompt}\n\n${workspaceCtx}` : basePrompt;
}
