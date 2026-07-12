import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import CommandPalette, { useCommandPaletteHotkey } from "../../components/command-palette";

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

function renderHotkeyPalette(initialOpen = false) {
  return render(
    <MemoryRouter initialEntries={["/overview"]}>
      <HotkeyPalette initialOpen={initialOpen} />
    </MemoryRouter>
  );
}

function HotkeyPalette(props: { readonly initialOpen: boolean }) {
  const [open, setOpen] = useState(props.initialOpen);
  useCommandPaletteHotkey(open, () => setOpen((prev) => !prev));
  return <CommandPalette open={open} onClose={() => setOpen(false)} />;
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

  it("closes on Escape without being reopened by the global hotkey listener", async () => {
    const user = userEvent.setup();
    renderHotkeyPalette(true);
    const input = screen.getByPlaceholderText(/jump to page/i);
    await waitFor(() => expect(document.activeElement).toBe(input));

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens and closes with Ctrl+K and Cmd+K", async () => {
    const user = userEvent.setup();
    renderHotkeyPalette();

    await user.keyboard("{Control>}k{/Control}");
    expect(await screen.findByRole("dialog")).toBeTruthy();

    await user.keyboard("{Meta>}k{/Meta}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("activates the item selected with arrow navigation and Enter", async () => {
    const user = userEvent.setup();
    renderPalette();
    const input = screen.getByPlaceholderText(/jump to page/i);
    await waitFor(() => expect(document.activeElement).toBe(input));

    await user.keyboard("{ArrowDown}{Enter}");

    expect(screen.getByTestId("location").textContent).toBe("/governance");
  });

  it("closes when clicking outside the palette content", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPalette();

    await user.click(screen.getByRole("dialog"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
