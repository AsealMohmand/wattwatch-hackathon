// F1-1: notification center. A bell in the topbar opens a right-hand
// drawer listing the latest alerts and insights; "Mark all read" is stored
// locally (per-browser, not synced to the server — there's no unread flag
// in the API, only timestamps), so the unread count is "newer than the
// last time this browser marked read."
import { Bell, FileText, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAlerts, useInsights } from "../api/hooks";
import { formatRelative } from "../lib/format";
import { SeverityTag } from "./SeverityTag";

const READ_KEY = "ww-notifications-read-ts";

function getReadTs(): number {
  try {
    return Number(localStorage.getItem(READ_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function setReadTs(ts: number) {
  try {
    localStorage.setItem(READ_KEY, String(ts));
  } catch {
    // ignore (private mode, blocked storage)
  }
}

export function NotificationDrawer() {
  const [open, setOpen] = useState(false);
  const [readTs, setReadTsState] = useState(getReadTs);
  const alerts = useAlerts({ status: "active", limit: 10 });
  const insights = useInsights(5);

  const alertList = alerts.data ?? [];
  const insightList = insights.data ?? [];
  const unread = alertList.filter((a) => a.opened_ts > readTs).length + insightList.filter((i) => i.created_ts > readTs).length;

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  function markAllRead() {
    const now = Date.now();
    setReadTs(now);
    setReadTsState(now);
  }

  return (
    <>
      <button
        type="button"
        data-testid="notification-bell"
        aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ""}`}
        onClick={() => setOpen(true)}
        className="relative flex h-9 w-9 items-center justify-center rounded-md border border-border text-text-muted transition-colors hover:text-text hover:bg-surface-raised"
      >
        <Bell size={16} />
        {unread > 0 && (
          <span
            data-testid="notification-unread-count"
            className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 font-mono-nums text-[10px] text-[#1b1200]"
          >
            {unread}
          </span>
        )}
      </button>

      {open && (
        <div
          data-testid="notification-drawer"
          className="fixed inset-0 z-50 flex justify-end bg-black/50"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex h-full w-full max-w-sm flex-col gap-0 overflow-hidden border-l border-border bg-surface"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-sm font-medium text-text">Notifications</h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="notification-mark-all-read"
                  onClick={markAllRead}
                  className="rounded-md px-2 py-1 text-xs text-text-muted transition-colors hover:text-text hover:bg-surface-raised"
                >
                  Mark all read
                </button>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => setOpen(false)}
                  className="rounded-md p-1 text-text-muted transition-colors hover:bg-surface-raised"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              <div className="flex flex-col gap-1 p-3">
                <h3 className="px-1 text-xs font-medium text-text-muted">Active alerts</h3>
                {alertList.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-text-muted">No active alerts.</p>
                ) : (
                  alertList.map((a) => (
                    <Link
                      key={a.id}
                      to={`/alerts?open=${a.id}`}
                      onClick={() => setOpen(false)}
                      data-testid="notification-alert-item"
                      className={`flex flex-col gap-1 rounded-md px-2 py-2 text-sm transition-colors hover:bg-surface-raised ${
                        a.opened_ts > readTs ? "bg-surface-raised/60" : ""
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <SeverityTag severity={a.severity} />
                        <span className="truncate text-text">{a.title}</span>
                      </span>
                      <span className="font-mono-nums text-xs text-text-muted">{formatRelative(a.opened_ts)}</span>
                    </Link>
                  ))
                )}
              </div>
              <div className="flex flex-col gap-1 border-t border-border p-3">
                <h3 className="px-1 text-xs font-medium text-text-muted">Latest insights</h3>
                {insightList.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-text-muted">No digests yet.</p>
                ) : (
                  insightList.map((i) => (
                    <Link
                      key={i.id}
                      to="/ai/insights"
                      onClick={() => setOpen(false)}
                      data-testid="notification-insight-item"
                      className={`flex flex-col gap-1 rounded-md px-2 py-2 text-sm transition-colors hover:bg-surface-raised ${
                        i.created_ts > readTs ? "bg-surface-raised/60" : ""
                      }`}
                    >
                      <span className="flex items-center gap-2 text-text">
                        <FileText size={13} className="shrink-0 text-text-muted" />
                        <span className="truncate">{i.title}</span>
                      </span>
                      <span className="font-mono-nums text-xs text-text-muted">{formatRelative(i.created_ts)}</span>
                    </Link>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
