import { NavLink, Outlet } from "react-router-dom";
import {
  BookOpen,
  Cpu,
  LayoutDashboard,
  Network,
  ShieldCheck,
  type LucideIcon
} from "lucide-react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { useI18n } from "../i18n/locale";
import type { DictKey, Locale } from "../i18n/dict";

function cn(...inputs: unknown[]): string {
  return twMerge(clsx(inputs));
}

interface NavItem {
  readonly to: string;
  readonly labelKey: DictKey;
  readonly Icon: LucideIcon;
}

const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { to: "/overview", labelKey: "nav:overview", Icon: LayoutDashboard },
  { to: "/governance", labelKey: "nav:governance", Icon: ShieldCheck },
  { to: "/memory-browser", labelKey: "nav:browse", Icon: BookOpen },
  { to: "/graph", labelKey: "nav:memoryGraph", Icon: Network },
  { to: "/system", labelKey: "nav:system", Icon: Cpu }
];

export default function Layout() {
  const { t, locale, setLocale } = useI18n();
  return (
    <div className="h-screen min-h-screen flex flex-col sm:flex-row">
      <Sidebar locale={locale} setLocale={setLocale} t={t} />
      <MobileHeader locale={locale} setLocale={setLocale} t={t} />
      <main className="flex-1 min-h-0 flex flex-col relative overflow-hidden pb-14 sm:pb-0">
        <Outlet />
      </main>
      <MobileTabs t={t} />
    </div>
  );
}

function Sidebar(props: LanguageToggleProps) {
  return (
    <aside data-testid="inspector-sidebar" className="hidden sm:flex sm:flex-col sm:w-56 sm:shrink-0 border-r border-beige-200 bg-beige-100/60 backdrop-blur-sm">
      <BrandHeader size="desktop" t={props.t} />
      <nav className="flex-1 flex flex-col gap-1 py-4 px-2">
        {NAV_ITEMS.map((item) => <DesktopNavLink key={item.to} item={item} t={props.t} />)}
      </nav>
      <div className="px-3 py-3 border-t border-beige-200 flex justify-center">
        <LanguageToggle {...props} />
      </div>
    </aside>
  );
}

function MobileHeader(props: LanguageToggleProps) {
  return (
    <header data-testid="inspector-mobile-header" className="sm:hidden flex items-center justify-between h-12 px-4 border-b border-beige-200 bg-beige-100/80 backdrop-blur-sm">
      <BrandHeader size="mobile" t={props.t} />
      <LanguageToggle {...props} />
    </header>
  );
}

function MobileTabs({ t }: { readonly t: (key: DictKey) => string }) {
  return (
    <nav data-testid="inspector-mobile-tabs" className="sm:hidden fixed bottom-0 inset-x-0 z-40 h-14 grid grid-cols-5 border-t border-beige-200 bg-beige-100/95 backdrop-blur-sm">
      {NAV_ITEMS.map((item) => <MobileNavLink key={item.to} item={item} t={t} />)}
    </nav>
  );
}

function BrandHeader(props: { readonly size: "desktop" | "mobile"; readonly t: (key: DictKey) => string }) {
  const dotSize = props.size === "desktop" ? "w-6 h-6" : "w-5 h-5";
  const wrapper = props.size === "desktop" ? "h-14 px-5 border-b border-beige-200" : "";
  return (
    <div className={`flex items-center gap-2 ${wrapper}`}>
      <div className={`${dotSize} rounded-full bg-morandi-sage animate-pulse`} />
      <span className="font-bold text-ink-600 text-sm">{props.t("nav:appName")}</span>
    </div>
  );
}

function DesktopNavLink(props: { readonly item: NavItem; readonly t: (key: DictKey) => string }) {
  const Icon = props.item.Icon;
  return (
    <NavLink key={props.item.to} to={props.item.to} className={({ isActive }) => desktopNavClass(isActive)}>
      <Icon className="w-4 h-4" />
      <span>{props.t(props.item.labelKey)}</span>
    </NavLink>
  );
}

function MobileNavLink(props: { readonly item: NavItem; readonly t: (key: DictKey) => string }) {
  const Icon = props.item.Icon;
  return (
    <NavLink key={props.item.to} to={props.item.to} className={({ isActive }) => mobileNavClass(isActive)}>
      <Icon className="w-4 h-4" />
      <span>{props.t(props.item.labelKey)}</span>
    </NavLink>
  );
}

function desktopNavClass(isActive: boolean): string {
  return cn(
    "flex items-center gap-2 rounded px-3 py-2 text-sm font-medium transition-colors",
    isActive ? "bg-ink-600/10 text-ink-600" : "text-ink-700/60 hover:text-ink-700 hover:bg-beige-200/60"
  );
}

function mobileNavClass(isActive: boolean): string {
  return cn(
    "flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors",
    isActive ? "text-ink-600" : "text-ink-700/55"
  );
}

interface LanguageToggleProps {
  readonly locale: Locale;
  readonly setLocale: (next: Locale) => void;
  readonly t: (key: DictKey) => string;
}

function LanguageToggle({ locale, setLocale, t }: LanguageToggleProps) {
  return (
    <div
      className="flex items-center gap-1 rounded-full border border-beige-200 bg-beige-50 p-0.5 shadow-sm"
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
            ? "bg-ink-600 text-beige-50"
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
            ? "bg-ink-600 text-beige-50"
            : "text-ink-700/60 hover:text-ink-700"
        )}
      >
        {t("nav:locale.en")}
      </button>
    </div>
  );
}
