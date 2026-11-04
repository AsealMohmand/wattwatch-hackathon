import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { SeverityTag } from "./SeverityTag";
import type { AlertSeverity } from "../api/client";

interface ToastItem {
  id: string;
  title: string;
  severity: AlertSeverity;
  href: string;
}

interface ToastContextValue {
  push: (toast: Omit<ToastItem, "id">) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DISMISS_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const push = useCallback((toast: Omit<ToastItem, "id">) => {
    const id = `t${counter.current++}`;
    setToasts((prev) => [...prev, { ...toast, id }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, DISMISS_MS);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        data-testid="toast-stack"
        className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <Link
            key={t.id}
            to={t.href}
            data-testid="toast"
            className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-raised px-3 py-2.5 shadow-lg transition-colors hover:border-trace"
            onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
          >
            <SeverityTag severity={t.severity} />
            <span className="text-sm text-text">{t.title}</span>
          </Link>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
