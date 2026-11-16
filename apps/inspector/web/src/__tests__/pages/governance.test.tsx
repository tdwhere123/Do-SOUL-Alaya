import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import GovernancePage from "../../pages/governance";

vi.mock("../../pages/proposals", () => ({
  default: () => <div data-testid="proposals-child">proposals</div>
}));
vi.mock("../../pages/health-inbox", () => ({
  default: () => <div data-testid="health-inbox-child">health inbox</div>
}));

function LocationProbe() {
  return <output data-testid="location-search">{useLocation().search}</output>;
}

function renderGovernance(initialEntry = "/governance") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <GovernancePage />
      <LocationProbe />
    </MemoryRouter>
  );
}

describe("GovernancePage", () => {
  it("retains tab roles, selection styling and unrelated query parameters", async () => {
    const user = userEvent.setup();
    renderGovernance("/governance?workspace=workspace-1&tab=unknown");
    const primary = screen.getByTestId("governance-tab-proposals");
    const secondary = screen.getByTestId("governance-tab-health-inbox");
    expect(screen.getByTestId("governance-tabs").getAttribute("role")).toBe("tablist");
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
    expect(screen.getByTestId("location-search").textContent).toBe("?workspace=workspace-1&tab=health-inbox");
  });

  it("defaults to the proposals tab", () => {
    renderGovernance();
    expect(screen.getByTestId("proposals-child")).toBeTruthy();
    expect(screen.queryByTestId("health-inbox-child")).toBeNull();
  });

  it("renders the health inbox tab when ?tab=health-inbox", () => {
    renderGovernance("/governance?tab=health-inbox");
    expect(screen.getByTestId("health-inbox-child")).toBeTruthy();
    expect(screen.queryByTestId("proposals-child")).toBeNull();
  });

  it("switches tabs on click", async () => {
    const user = userEvent.setup();
    renderGovernance();
    await user.click(screen.getByTestId("governance-tab-health-inbox"));
    expect(screen.getByTestId("health-inbox-child")).toBeTruthy();
    await user.click(screen.getByTestId("governance-tab-proposals"));
    expect(screen.getByTestId("proposals-child")).toBeTruthy();
  });
});
