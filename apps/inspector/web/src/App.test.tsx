import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppContent } from "./App";
import { ToastProvider } from "./components/Toast";

vi.mock("./pages/Config", () => ({
  default: () => <div>config page</div>
}));

vi.mock("./pages/Graph", () => ({
  default: () => <div>graph page</div>
}));

vi.mock("./pages/Status", () => ({
  default: () => <div>status page</div>
}));

describe("AppContent", () => {
  it("keeps the launch token after redirecting from / to /config", async () => {
    render(
      <MemoryRouter initialEntries={["/?token=test-token&workspaceId=ws1"]}>
        <ToastProvider>
          <AppContent />
        </ToastProvider>
      </MemoryRouter>
    );

    expect(await screen.findByText("config page")).toBeTruthy();
    expect(
      screen.queryByText("No token found in URL. Please run `alaya inspect` to open this tool.")
    ).toBeNull();
  });
});
