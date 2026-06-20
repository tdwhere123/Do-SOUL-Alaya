import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import CommandPalette from "../../components/CommandPalette";

function renderPalette(onClose = vi.fn()) {
  return {
    onClose,
    ...render(
      <MemoryRouter initialEntries={["/overview"]}>
        <CommandPalette open={true} onClose={onClose} />
        <LocationProbe />
      </MemoryRouter>
    )
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

describe("CommandPalette", () => {
  it("filters page entries and navigates through the selected item", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPalette();
    await user.type(screen.getByPlaceholderText(/jump to page/i), "graph");
    await user.click(screen.getByText("Graph"));
    expect(screen.getByTestId("location").textContent).toBe("/graph");
    expect(onClose).toHaveBeenCalled();
  });

  it("copies CLI verbs instead of executing them", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPalette();
    await user.type(screen.getByPlaceholderText(/jump to page/i), "review");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    await user.click(screen.getByText("alaya review pending"));
    expect(writeText).toHaveBeenCalledWith("alaya review pending");
    expect(onClose).toHaveBeenCalled();
  });
});
