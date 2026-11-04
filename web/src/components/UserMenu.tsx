import { ChevronDown, Keyboard, Moon, Sun, UserRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { applyTheme, getStoredTheme, type Theme } from "../lib/theme";

/** F1-1: user menu — "Local admin" (there's one user, no auth), the theme
 * toggle (moved here from its own topbar button) and a keyboard shortcuts
 * dialog. */
export function UserMenu() {
  const [open, setOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(getStoredTheme);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        data-testid="user-menu-trigger"
        aria-label="User menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 items-center gap-1 rounded-md border border-border px-2 text-text-muted transition-colors hover:text-text hover:bg-surface-raised"
      >
        <UserRound size={16} />
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          data-testid="user-menu"
          className="absolute right-0 top-10 z-40 w-56 rounded-md border border-border bg-surface p-1.5 shadow-xl"
        >
          <div className="px-2.5 py-2 text-sm text-text">Local admin</div>
          <button
            type="button"
            data-testid="user-menu-theme"
            onClick={() => {
              setTheme((t) => (t === "dark" ? "light" : "dark"));
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm text-text-muted transition-colors hover:bg-surface-raised hover:text-text"
          >
            {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
            {theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          </button>
          <button
            type="button"
            data-testid="user-menu-shortcuts"
            onClick={() => {
              setOpen(false);
              setShortcutsOpen(true);
            }}
            className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm text-text-muted transition-colors hover:bg-surface-raised hover:text-text"
          >
            <Keyboard size={14} />
            Keyboard shortcuts
          </button>
        </div>
      )}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      data-testid="shortcuts-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded border border-border bg-surface p-4"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-text">Keyboard shortcuts</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-md p-1 text-text-muted hover:bg-surface-raised">
            <X size={16} />
          </button>
        </div>
        <dl className="flex flex-col gap-2 text-sm">
          <Row keys="Ctrl / &#8984; K" desc="Open the command palette" />
          <Row keys="Esc" desc="Close a dialog or drawer" />
          <Row keys="Enter" desc="Save an inline field" />
        </dl>
      </div>
    </div>
  );
}

function Row({ keys, desc }: { keys: string; desc: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-text-muted">{desc}</span>
      <kbd
        className="shrink-0 rounded border border-border bg-surface-raised px-1.5 py-0.5 font-mono-nums text-xs text-text"
        dangerouslySetInnerHTML={{ __html: keys }}
      />
    </div>
  );
}
