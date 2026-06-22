import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ErrorBoundary from "../../app/ErrorBoundary";

function Boom(): never {
  throw new Error("kaboom");
}

function renderBoundary(child: React.ReactNode) {
  return render(
    <MemoryRouter>
      <ErrorBoundary>{child}</ErrorBoundary>
    </MemoryRouter>
  );
}

describe("ErrorBoundary", () => {
  it("shows the fallback UI with a return-home link when a child throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    renderBoundary(<Boom />);

    expect(screen.getByTestId("error-boundary-fallback")).toBeTruthy();
    expect(screen.getByText("kaboom")).toBeTruthy();
    const home = screen.getByText("返回首页");
    expect(home.getAttribute("href")).toBe("/");
  });

  it("renders children normally when nothing throws", () => {
    renderBoundary(<p>healthy surface</p>);

    expect(screen.getByText("healthy surface")).toBeTruthy();
    expect(screen.queryByTestId("error-boundary-fallback")).toBeNull();
  });
});
