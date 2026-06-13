import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import SystemPage from "../../pages/System";

vi.mock("../../pages/Status", () => ({
  default: () => <div data-testid="status-child">status</div>
}));
vi.mock("../../pages/Config", () => ({
  default: () => <div data-testid="config-child">config</div>
}));

function renderSystem(initialEntry = "/system") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SystemPage />
    </MemoryRouter>
  );
}

describe("SystemPage", () => {
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
