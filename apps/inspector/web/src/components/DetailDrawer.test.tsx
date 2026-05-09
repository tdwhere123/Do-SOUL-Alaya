import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { DetailDrawer } from "./DetailDrawer";
import type { GraphNode } from "../types/graph";

const NODE: GraphNode = {
  id: "memory-1",
  kind: "memory",
  label: "Prefer rtk commands",
  summary: "Use rtk for repository shell commands.",
  origin_kind: "user_memory",
  evidence_refs: ["MEMORY.md:445"],
  rationale: "Explicit user or reviewer-governed memory.",
  confidence: 0.72,
  last_used_at: "2026-05-05T01:00:00.000Z",
  last_hit_at: "2026-05-05T02:00:00.000Z",
  influence_count: 14,
  workspace_id: "ws-1",
  scope_id: "project",
  created_at: "2026-05-05T00:00:00.000Z",
  degree: 3
};

describe("DetailDrawer", () => {
  it("renders Inspector graph metadata sections when fields are present", () => {
    renderDrawer();

    expect(screen.getByText("What's remembered")).toBeTruthy();
    expect(screen.getByText("Evidence")).toBeTruthy();
    expect(screen.getByText("Trust")).toBeTruthy();
    expect(screen.getByText("Usage")).toBeTruthy();
    expect(screen.getByText("Actions")).toBeTruthy();
    expect(screen.getByText("Metadata")).toBeTruthy();
    expect(screen.getByText("user memory")).toBeTruthy();
    expect(screen.getByText("0.72")).toBeTruthy();
    expect(screen.getByText("14 paths reinforced")).toBeTruthy();
  });

  it("hides optional sections when graph fields are absent", () => {
    renderDrawer({
      node: {
        id: "projection-1",
        kind: "projection",
        label: "Pending proposal",
        degree: 0
      }
    });

    expect(screen.queryByText("What's remembered")).toBeNull();
    expect(screen.queryByText("Evidence")).toBeNull();
    expect(screen.queryByText("Trust")).toBeNull();
    expect(screen.queryByText("Usage")).toBeNull();
    expect(screen.queryByText("Actions")).toBeNull();
    expect(screen.getByText("Metadata")).toBeTruthy();
  });

  it("creates a rewrite proposal through the parent callback", async () => {
    const onCreateProposal = vi.fn(async () => undefined);
    renderDrawer({ onCreateProposal });

    await userEvent.clear(screen.getByLabelText("Rewrite content"));
    await userEvent.type(screen.getByLabelText("Rewrite content"), "Use rtk for every repo shell command.");
    await userEvent.click(screen.getByRole("button", { name: /rewrite/i }));

    await waitFor(() => {
      expect(onCreateProposal).toHaveBeenCalledWith(
        "rewrite",
        "memory-1",
        "Use rtk for every repo shell command."
      );
    });
  });

  it("creates keep, downgrade, and retire proposals without direct entry mutation", async () => {
    const onCreateProposal = vi.fn(async () => undefined);
    renderDrawer({ onCreateProposal });

    await userEvent.click(screen.getByRole("button", { name: /keep/i }));
    await waitFor(() => expect(onCreateProposal).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: /downgrade/i }));
    await waitFor(() => expect(onCreateProposal).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole("button", { name: /delete/i }));
    await waitFor(() => expect(onCreateProposal).toHaveBeenCalledTimes(3));

    expect(onCreateProposal).toHaveBeenNthCalledWith(1, "keep", "memory-1", undefined);
    expect(onCreateProposal).toHaveBeenNthCalledWith(2, "downgrade", "memory-1", undefined);
    expect(onCreateProposal).toHaveBeenNthCalledWith(3, "retire", "memory-1", undefined);
  });
});

function renderDrawer(
  overrides: Partial<ComponentProps<typeof DetailDrawer>> = {}
) {
  const props: ComponentProps<typeof DetailDrawer> = {
    node: NODE,
    onClose: vi.fn(),
    onFocusSubgraph: vi.fn(),
    onCopyCli: vi.fn(),
    onCreateProposal: vi.fn(async () => undefined),
    ...overrides
  };
  return render(<DetailDrawer {...props} />);
}
