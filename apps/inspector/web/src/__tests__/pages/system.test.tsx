import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import SystemPage from "../../pages/system";

vi.mock("../../pages/status", () => ({
  default: () => <div data-testid="status-child">status</div>
}));
vi.mock("../../pages/config", () => ({
  default: () => <div data-testid="config-child">config</div>
}));

function LocationProbe() {
  return <output data-testid="location-search">{useLocation().search}</output>;
}

function renderSystem(initialEntry = "/system") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SystemPage />
      <LocationProbe />
    </MemoryRouter>
  );
}

describe("SystemPage", () => {
  it("retains tab roles, selection styling and unrelated query parameters", async () => {
    const user = userEvent.setup();
    renderSystem("/system?workspace=workspace-1&tab=unknown");
    const primary = screen.getByTestId("system-tab-status");
    const secondary = screen.getByTestId("system-tab-config");
    expect(screen.getByTestId("system-tabs").getAttribute("role")).toBe("tablist");
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(primary.getAttribute("type")).toBe("button");
    expect(primary.getAttribute("aria-selected")).toBe("true");
    expect(secondary.getAttribute("aria-selected")).toBe("false");
    expect(primary.classList.contains("border-ink-600")).toBe(true);
    expect(secondary.classList.contains("border-transparent")).toBe(true);

    await user.click(secondary);
    expect(primary.getAttribute("aria-selected")).toBe("false");
    expect(secondary.getAttribute("aria-selected")).toBe("true");
    expect(secondary.classList.contains("border-ink-600")).toBe(true);
    expect(primary.classList.contains("border-transparent")).toBe(true);
    expect(screen.getByTestId("location-search").textContent).toBe("?workspace=workspace-1&tab=config");
  });

  it("defaults to the status tab", () => {
    renderSystem();
    expect(screen.getByTestId("status-child")).toBeTruthy();
    expect(screen.queryByTestId("config-child")).toBeNull();
  });

  it("renders the config tab when ?tab=config", () => {
    renderSystem("/system?tab=config");
    expect(screen.getByTestId("config-child")).toBeTruthy();
    expect(screen.queryByTestId("status-child")).toBeNull();
  });

  it("switches tabs on click", async () => {
    const user = userEvent.setup();
    renderSystem();
    await user.click(screen.getByTestId("system-tab-config"));
    expect(screen.getByTestId("config-child")).toBeTruthy();
    await user.click(screen.getByTestId("system-tab-status"));
    expect(screen.getByTestId("status-child")).toBeTruthy();
  });
});
