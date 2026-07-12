import { NavLink, Outlet } from "react-router-dom";
import {
  Archive,
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
    <div className="h-screen min-h-screen flex flex-col bg-beige-100 sm:flex-row">
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
    <aside data-testid="inspector-sidebar" className="hidden sm:flex sm:w-56 sm:shrink-0 sm:flex-col border-r border-beige-300 bg-beige-100/80 backdrop-blur-sm">
      <BrandHeader size="desktop" t={props.t} />
      <nav aria-label={props.t("nav:primary")} className="flex flex-1 flex-col gap-1 px-2 py-4">
        {NAV_ITEMS.map((item) => <DesktopNavLink key={item.to} item={item} t={props.t} />)}
      </nav>
      <div className="flex justify-center border-t border-beige-300 px-3 py-3">
        <LanguageToggle {...props} />
      </div>
    </aside>
  );
}

function MobileHeader(props: LanguageToggleProps) {
  return (
    <header data-testid="inspector-mobile-header" className="flex h-12 items-center justify-between border-b border-beige-300 bg-beige-100/90 px-4 backdrop-blur-sm sm:hidden">
      <BrandHeader size="mobile" t={props.t} />
      <LanguageToggle {...props} />
    </header>
  );
}

function MobileTabs({ t }: { readonly t: (key: DictKey) => string }) {
  return (
    <nav aria-label={t("nav:mobile")} data-testid="inspector-mobile-tabs" className="fixed inset-x-0 bottom-0 z-40 grid h-14 grid-cols-5 border-t border-beige-300 bg-beige-100/95 backdrop-blur-sm sm:hidden">
      {NAV_ITEMS.map((item) => <MobileNavLink key={item.to} item={item} t={t} />)}
    </nav>
  );
}

function BrandHeader(props: { readonly size: "desktop" | "mobile"; readonly t: (key: DictKey) => string }) {
  const markSize = props.size === "desktop" ? "h-6 w-6" : "h-5 w-5";
  const wrapper = props.size === "desktop" ? "h-14 px-5 border-b border-beige-200" : "";
  return (
    <div className={`flex items-center gap-2 ${wrapper}`}>
      <span className={`${markSize} flex shrink-0 items-center justify-center rounded border border-morandi-orange/70 bg-morandi-orange/20 text-ink-600`}>
        <Archive aria-hidden="true" className={props.size === "desktop" ? "h-4 w-4" : "h-3.5 w-3.5"} strokeWidth={1.8} />
      </span>
      <span className="font-bold text-sm text-ink-600">{props.t("nav:appName")}</span>
    </div>
  );
}

function DesktopNavLink(props: { readonly item: NavItem; readonly t: (key: DictKey) => string }) {
  const Icon = props.item.Icon;
  const label = props.t(props.item.labelKey);
  return (
    <NavLink key={props.item.to} to={props.item.to} className={({ isActive }) => desktopNavClass(isActive)}>
      <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </NavLink>
  );
}

function MobileNavLink(props: { readonly item: NavItem; readonly t: (key: DictKey) => string }) {
  const Icon = props.item.Icon;
  const label = props.t(props.item.labelKey);
  return (
    <NavLink key={props.item.to} to={props.item.to} aria-label={label} className={({ isActive }) => mobileNavClass(isActive)}>
      <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
      <span className="min-w-0 max-w-full truncate">{label}</span>
    </NavLink>
  );
}

function desktopNavClass(isActive: boolean): string {
  return cn(
    "flex min-w-0 items-center gap-2 rounded border-l-2 border-transparent px-3 py-2 text-sm font-medium transition-colors",
    isActive ? "border-morandi-orange bg-ink-600/10 text-ink-600" : "text-ink-700/60 hover:bg-beige-200/60 hover:text-ink-700"
  );
}

function mobileNavClass(isActive: boolean): string {
  return cn(
    "flex min-w-0 flex-col items-center justify-center gap-0.5 border-t-2 border-transparent px-1 text-[10px] font-medium leading-none transition-colors",
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
      aria-label={t("nav:locale.label")}
    >
      <button
        type="button"
        onClick={() => setLocale("zh")}
        aria-pressed={locale === "zh"}
        aria-label={t("nav:locale.zh.aria")}
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
        aria-label={t("nav:locale.en.aria")}
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
