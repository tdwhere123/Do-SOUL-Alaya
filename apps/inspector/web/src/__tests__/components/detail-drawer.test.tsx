import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import DetailDrawer from "../../components/detail-drawer";
import type { GraphNode } from "../../types/graph";

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

  it("hides the closed drawer from complementary landmarks", () => {
    const onClose = vi.fn();
    const view = renderDrawer({ onClose });

    expect(screen.getByRole("complementary").getAttribute("aria-hidden")).toBe("false");

    view.rerender(
      <DetailDrawer
        node={null}
        onClose={onClose}
        onFocusSubgraph={vi.fn()}
        onCopyCli={vi.fn()}
        onCreateProposal={vi.fn(async () => undefined)}
      />
    );

    expect(document.querySelector('[role="complementary"]')?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("complementary")).toBeNull();
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

  // On the path plane node.id is a serialized PathAnchorRef (e.g.
  // '["object","mem-1"]') and node.object_id is the bare memory object id
  // ("mem-1"). Both the proposal flow and the open_pointer CLI string must
  // address the bare object id, NOT the serialized anchor. This fixture has
  // object_id !== id so a regression to node.id would fail (the NODE fixture
  // above has no object_id and only exercises the id===object_id fallback).
  it("uses node.object_id, not the serialized anchor id, for proposals and the CLI string", async () => {
    const onCreateProposal = vi.fn(async () => undefined);
    const onCopyCli = vi.fn();
    const serializedAnchor = '["object","mem-1"]';
    renderDrawer({
      node: {
        id: serializedAnchor,
        object_id: "mem-1",
        kind: "memory",
        label: "Prefer rtk commands",
        summary: "Use rtk for repository shell commands.",
        degree: 1
      },
      onCreateProposal,
      onCopyCli
    });

    await userEvent.click(screen.getByRole("button", { name: /keep/i }));
    await waitFor(() => {
      expect(onCreateProposal).toHaveBeenCalledWith("keep", "mem-1", undefined);
    });
    // The proposal target must be the bare object id, never the anchor.
    expect(onCreateProposal).not.toHaveBeenCalledWith("keep", serializedAnchor, undefined);

    await userEvent.click(screen.getByRole("button", { name: /delete/i }));
    await waitFor(() => {
      expect(onCreateProposal).toHaveBeenCalledWith("retire", "mem-1", undefined);
    });

    // The open-in-CLI command targets the bare object id via pointer_id, not
    // the serialized anchor.
    await userEvent.click(screen.getByRole("button", { name: /open in cli/i }));
    await waitFor(() => {
      expect(onCopyCli).toHaveBeenCalled();
    });
    const cliCall = onCopyCli.mock.calls.find(([text]) =>
      typeof text === "string" && text.includes("open_pointer")
    );
    expect(cliCall).toBeDefined();
    expect(cliCall?.[0]).toContain('"pointer_id":"mem-1"');
    expect(cliCall?.[0]).not.toContain(serializedAnchor);
  });

  // canAct is gated on node.kind === "memory". A scope/concern anchor (no
  // object_id) must never render the Actions section, so it can never trigger
  // a memory proposal.
  it("hides the Actions section for a non-memory (scope) node so it cannot trigger a proposal", () => {
    const onCreateProposal = vi.fn(async () => undefined);
    renderDrawer({
      node: {
        id: '["risk_concern","mem-2","digest-abc"]',
        kind: "scope",
        label: "Risk concern anchor",
        summary: "A path-plane concern anchor.",
        degree: 2
      },
      onCreateProposal
    });

    expect(screen.queryByText("Actions")).toBeNull();
    expect(screen.queryByRole("button", { name: /keep/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /downgrade/i })).toBeNull();
    expect(screen.queryByLabelText("Rewrite content")).toBeNull();
    expect(onCreateProposal).not.toHaveBeenCalled();
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
