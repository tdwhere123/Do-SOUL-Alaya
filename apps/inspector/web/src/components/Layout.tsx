import { NavLink, Outlet } from 'react-router-dom';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: any[]) {
  return twMerge(clsx(inputs));
}

export default function Layout() {
  const navItems = [
    { to: '/config', label: 'Configuration' },
    { to: '/graph', label: 'Memory Graph' },
    { to: '/status', label: 'System Status' },
  ];

  return (
    <div className="min-h-screen flex flex-col">
      {/* Minimal Top Navigation */}
      <header className="sticky top-0 z-50 bg-beige-100/80 backdrop-blur-sm border-b border-beige-200">
        <nav className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-morandi-sage animate-pulse" />
            <span className="font-bold tracking-tight text-ink-600">ALAYA INSPECTOR</span>
          </div>
          
          <div className="flex gap-8">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    "text-sm font-medium transition-colors hover:text-ink-600",
                    isActive ? "text-ink-600 border-b-2 border-ink-600 -mb-[1px]" : "text-ink-700/60"
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </div>
          
          <div className="text-[10px] text-ink-700/40 uppercase tracking-widest">
            v0.1.0-alpha
          </div>
        </nav>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col relative overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
