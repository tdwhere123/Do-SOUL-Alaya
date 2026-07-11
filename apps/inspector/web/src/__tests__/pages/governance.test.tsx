import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import GovernancePage from "../../pages/governance";

vi.mock("../../pages/proposals", () => ({
  default: () => <div data-testid="proposals-child">proposals</div>
}));
vi.mock("../../pages/health-inbox", () => ({
  default: () => <div data-testid="health-inbox-child">health inbox</div>
}));

function renderGovernance(initialEntry = "/governance") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <GovernancePage />
    </MemoryRouter>
  );
}

describe("GovernancePage", () => {
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
