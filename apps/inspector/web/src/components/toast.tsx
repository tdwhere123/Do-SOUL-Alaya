import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { AlertCircle, AlertTriangle, CheckCircle, Info, X } from "lucide-react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: unknown[]): string {
  return twMerge(clsx(inputs));
}

export type ToastType = "info" | "success" | "warning" | "error";

export interface ToastInput {
  readonly message: string;
  readonly type?: ToastType;
  readonly duration?: number;
  readonly action?: {
    readonly label: string;
    readonly onClick: () => void;
  };
}

interface ToastEntry extends ToastInput {
  readonly id: string;
}

const MAX_VISIBLE = 3;
const DEDUP_WINDOW_MS = 2000;

const icons: Record<ToastType, ReactNode> = {
  info: <Info className="w-5 h-5 text-morandi-blue" />,
  success: <CheckCircle className="w-5 h-5 text-morandi-green" />,
  warning: <AlertTriangle className="w-5 h-5 text-state-warm" />,
  error: <AlertCircle className="w-5 h-5 text-morandi-pink" />
};

interface ToastContextValue {
  showToast: (input: ToastInput) => void;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const recentRef = useRef<Map<string, number>>(new Map());

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback((input: ToastInput) => {
    const dedupKey = `${input.type ?? "info"}:${input.message}`;
    const now = Date.now();
    const last = recentRef.current.get(dedupKey);
    if (last !== undefined && now - last < DEDUP_WINDOW_MS) {
      return;
    }
    recentRef.current.set(dedupKey, now);

    const id = `${now}-${Math.random().toString(36).slice(2, 9)}`;
    setToasts((prev) => {
      const next = [...prev, { ...input, id }];
      return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
    });
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({ showToast, dismissToast }),
    [showToast, dismissToast]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-8 right-8 z-[100] flex flex-col gap-2">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onClose={() => dismissToast(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToasts(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToasts() must be used inside <ToastProvider>");
  }
  return ctx;
}

function ToastItem({ toast, onClose }: { toast: ToastEntry; onClose: () => void }) {
  const [visible, setVisible] = useState(false);
  const duration = toast.duration ?? 5000;

  useEffect(() => {
    setVisible(true);
    if (duration > 0) {
      const t = setTimeout(() => {
        setVisible(false);
        setTimeout(onClose, 250);
      }, duration);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [duration, onClose]);

  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-3 px-4 py-3 bg-beige-50 border border-beige-200 rounded-lg shadow-lg transition-all duration-250 transform",
        visible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
      )}
    >
      <div className="flex-shrink-0">{icons[toast.type ?? "info"]}</div>
      <div className="flex-1 text-sm font-mono text-ink-700">{toast.message}</div>
      {toast.action ? (
        <button
          onClick={toast.action.onClick}
          className="px-2 py-1 text-xs font-bold uppercase tracking-wider text-ink-600 hover:bg-beige-200 rounded transition-colors"
        >
          {toast.action.label}
        </button>
      ) : null}
      <button
        onClick={() => {
          setVisible(false);
          setTimeout(onClose, 250);
        }}
        className="text-ink-700/40 hover:text-ink-700 transition-colors"
        aria-label="Dismiss notification"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
