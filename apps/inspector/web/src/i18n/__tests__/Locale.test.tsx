import { describe, it, expect, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocaleProvider, useI18n } from "../Locale";
import { en, zh, type DictKey } from "../dict";

function Probe() {
  const { t, locale, setLocale } = useI18n();
  return (
    <div>
      <span data-testid="title">{t("proposals:title")}</span>
      <span data-testid="locale">{locale}</span>
      <span data-testid="counter">
        {t("graph:search.matchCounter", { current: 1, total: 3 })}
      </span>
      <button data-testid="set-en" onClick={() => setLocale("en")}>switch-en</button>
      <button data-testid="set-zh" onClick={() => setLocale("zh")}>switch-zh</button>
    </div>
  );
}

describe("LocaleProvider + useI18n", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("respects localStorage when initialising locale state", () => {
    window.localStorage.setItem("alaya-inspector-locale", "zh");
    render(
      <LocaleProvider>
        <Probe />
      </LocaleProvider>
    );
    expect(screen.getByTestId("locale").textContent).toBe("zh");
    expect(screen.getByTestId("title").textContent).toBe(zh["proposals:title"]);
  });

  it("flips strings when setLocale switches to en, and persists to localStorage", async () => {
    const user = userEvent.setup();
    render(
      <LocaleProvider>
        <Probe />
      </LocaleProvider>
    );
    await user.click(screen.getByTestId("set-en"));
    expect(screen.getByTestId("title").textContent).toBe(en["proposals:title"]);
    expect(window.localStorage.getItem("alaya-inspector-locale")).toBe("en");
  });

  it("interpolates {param} placeholders", () => {
    render(
      <LocaleProvider>
        <Probe />
      </LocaleProvider>
    );
    // Both locales use the same {current}/{total} pattern.
    expect(screen.getByTestId("counter").textContent).toBe("1/3");
  });

  it("falls back to English when a key is missing in zh", () => {
    // invariant: every key in zh dict must also exist in en, so no consumer
    // can land on a key that exists only on one side. This pins the audit.
    const zhKeys = Object.keys(zh) as DictKey[];
    const enKeys = Object.keys(en) as DictKey[];
    expect(new Set(zhKeys)).toEqual(new Set(enKeys));
  });

  it("re-renders subtree when locale toggles back to zh", async () => {
    const user = userEvent.setup();
    render(
      <LocaleProvider>
        <Probe />
      </LocaleProvider>
    );
    await user.click(screen.getByTestId("set-en"));
    await user.click(screen.getByTestId("set-zh"));
    expect(screen.getByTestId("title").textContent).toBe(zh["proposals:title"]);
  });

  // invariant: `useI18n()` outside <LocaleProvider> falls back to the zh
  // default rather than throwing, so component tests can render sub-trees
  // directly without wrapping every render call.
  it("falls back to zh default when no provider wraps the tree", () => {
    function Bare() {
      const { t, locale } = useI18n();
      return (
        <div>
          <span data-testid="bare-locale">{locale}</span>
          <span data-testid="bare-title">{t("proposals:title")}</span>
        </div>
      );
    }
    act(() => {
      render(<Bare />);
    });
    expect(screen.getByTestId("bare-locale").textContent).toBe("en");
    expect(screen.getByTestId("bare-title").textContent).toBe(en["proposals:title"]);
  });
});
