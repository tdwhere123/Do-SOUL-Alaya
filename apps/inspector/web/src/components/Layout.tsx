import { NavLink, Outlet } from "react-router-dom";
import { Activity, CheckSquare, Cpu, Network } from "lucide-react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { useI18n } from "../i18n/Locale";
import type { DictKey } from "../i18n/dict";

function cn(...inputs: unknown[]): string {
  return twMerge(clsx(inputs));
}

const NAV_ITEMS: ReadonlyArray<{
  readonly to: string;
  readonly labelKey: DictKey;
  readonly icon: JSX.Element;
}> = [
  { to: "/config", labelKey: "nav:configuration", icon: <Cpu className="w-4 h-4" /> },
  { to: "/graph", labelKey: "nav:memoryGraph", icon: <Network className="w-4 h-4" /> },
  { to: "/proposals", labelKey: "nav:pendingProposals", icon: <CheckSquare className="w-4 h-4" /> },
  { to: "/status", labelKey: "nav:systemStatus", icon: <Activity className="w-4 h-4" /> }
];

export default function Layout() {
  const { t, locale, setLocale } = useI18n();
  return (
    <div className="h-screen min-h-screen flex flex-col">
      <header className="sticky top-0 z-50 bg-beige-100/80 backdrop-blur-sm border-b border-beige-200">
        <nav className="max-w-7xl mx-auto px-4 sm:px-6 h-14 sm:h-16 grid grid-cols-[auto_1fr_auto] items-center gap-4">
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-5 h-5 sm:w-6 sm:h-6 rounded-full bg-morandi-sage animate-pulse" />
            <span className="font-bold tracking-tight text-ink-600 text-sm sm:text-base">
              {t("nav:appName")}
            </span>
          </div>

          <div className="flex justify-center gap-3 sm:gap-8 overflow-x-auto">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-1.5 text-xs sm:text-sm font-medium transition-colors hover:text-ink-600 py-1 whitespace-nowrap",
                    isActive
                      ? "text-ink-600 border-b-2 border-ink-600 -mb-[1px]"
                      : "text-ink-700/60"
                  )
                }
              >
                <span className="sm:hidden">{item.icon}</span>
                <span className="hidden sm:inline">{t(item.labelKey)}</span>
                <span className="sm:hidden">{t(item.labelKey)}</span>
              </NavLink>
            ))}
          </div>

          <div
            className="flex items-center gap-1 rounded-full border border-beige-200 bg-beige-50 p-0.5 shadow-sm shrink-0 justify-self-end"
            role="group"
            aria-label="Language"
          >
            <button
              type="button"
              onClick={() => setLocale("zh")}
              aria-pressed={locale === "zh"}
              className={cn(
                "px-2 py-0.5 rounded-full text-[10px] font-mono uppercase transition-colors",
                locale === "zh"
                  ? "bg-[#586E75] text-beige-50"
                  : "text-ink-700/60 hover:text-ink-700"
              )}
            >
              {t("nav:locale.zh")}
            </button>
            <button
              type="button"
              onClick={() => setLocale("en")}
              aria-pressed={locale === "en"}
              className={cn(
                "px-2 py-0.5 rounded-full text-[10px] font-mono uppercase transition-colors",
                locale === "en"
                  ? "bg-[#586E75] text-beige-50"
                  : "text-ink-700/60 hover:text-ink-700"
              )}
            >
              {t("nav:locale.en")}
            </button>
          </div>
        </nav>
      </header>

      <main className="flex-1 min-h-0 flex flex-col relative overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
