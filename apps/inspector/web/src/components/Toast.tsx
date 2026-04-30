import { useEffect, useState } from 'react';
import { X, Info, AlertTriangle, CheckCircle, AlertCircle } from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: any[]) {
  return twMerge(clsx(inputs));
}

export type ToastType = 'info' | 'success' | 'warning' | 'error';

export interface ToastProps {
  message: string;
  type?: ToastType;
  duration?: number;
  onClose: () => void;
  action?: {
    label: string;
    onClick: () => void;
  };
}

const icons = {
  info: <Info className="w-5 h-5 text-blue-500" />,
  success: <CheckCircle className="w-5 h-5 text-green-500" />,
  warning: <AlertTriangle className="w-5 h-5 text-amber-500" />,
  error: <AlertCircle className="w-5 h-5 text-red-500" />,
};

export default function Toast({ message, type = 'info', duration = 5000, onClose, action }: ToastProps) {
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    if (duration > 0) {
      const timer = setTimeout(() => {
        setIsVisible(false);
        setTimeout(onClose, 300); // Wait for fade out animation
      }, duration);
      return () => clearTimeout(timer);
    }
  }, [duration, onClose]);

  return (
    <div
      className={cn(
        "fixed bottom-8 right-8 z-[100] flex items-center gap-3 px-4 py-3 bg-beige-50 border border-beige-200 rounded-lg shadow-lg transition-all duration-300 transform",
        isVisible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
      )}
    >
      <div className="flex-shrink-0">{icons[type]}</div>
      <div className="flex-1 text-sm font-medium text-ink-600">{message}</div>
      
      {action && (
        <button
          onClick={action.onClick}
          className="px-2 py-1 text-xs font-bold uppercase tracking-wider text-ink-600 hover:bg-beige-200 rounded transition-colors"
        >
          {action.label}
        </button>
      )}

      <button
        onClick={() => {
          setIsVisible(false);
          setTimeout(onClose, 300);
        }}
        className="text-ink-700/40 hover:text-ink-700 transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

// Global Toast Manager Hook
export function useToasts() {
  const [toasts, setToasts] = useState<(ToastProps & { id: string })[]>([]);

  const showToast = (props: Omit<ToastProps, 'onClose'>) => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { ...props, id, onClose: () => hideToast(id) }]);
  };

  const hideToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  return { toasts, showToast, hideToast, ToastContainer: () => (
    <>
      {toasts.map((toast) => (
        <Toast key={toast.id} {...toast} />
      ))}
    </>
  )};
}
