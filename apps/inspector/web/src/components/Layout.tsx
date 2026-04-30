import { NavLink, Outlet } from "react-router-dom";
import { Cpu, Network, Activity } from "lucide-react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: unknown[]): string {
  return twMerge(clsx(inputs));
}

const NAV_ITEMS = [
  { to: "/config", label: "Configuration", icon: <Cpu className="w-4 h-4" /> },
  { to: "/graph", label: "Memory Graph", icon: <Network className="w-4 h-4" /> },
  { to: "/status", label: "System Status", icon: <Activity className="w-4 h-4" /> }
];

export default function Layout() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-50 bg-beige-100/80 backdrop-blur-sm border-b border-beige-200">
        <nav className="max-w-7xl mx-auto px-4 sm:px-6 h-14 sm:h-16 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-5 h-5 sm:w-6 sm:h-6 rounded-full bg-morandi-sage animate-pulse" />
            <span className="font-bold tracking-tight text-ink-600 text-sm sm:text-base">
              ALAYA INSPECTOR
            </span>
          </div>

          <div className="flex gap-2 sm:gap-8 order-3 sm:order-none w-full sm:w-auto">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-1.5 text-xs sm:text-sm font-medium transition-colors hover:text-ink-600 py-1",
                    isActive
                      ? "text-ink-600 border-b-2 border-ink-600 -mb-[1px]"
                      : "text-ink-700/60"
                  )
                }
              >
                <span className="sm:hidden">{item.icon}</span>
                <span className="hidden sm:inline">{item.label}</span>
                <span className="sm:hidden">{item.label}</span>
              </NavLink>
            ))}
          </div>

          <div className="text-[10px] text-ink-700/40 uppercase tracking-widest shrink-0">
            v0.1.0-alpha
          </div>
        </nav>
      </header>

      <main className="flex-1 flex flex-col relative overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
