import { useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Bolt,
  Bot,
  Cpu,
  Gauge,
  LineChart,
  ListTree,
  Menu,
  Server,
  Siren,
  Sparkles,
  SlidersHorizontal,
  Command as CommandIcon,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAlerts } from "../api/hooks";
import { useStreamBridge, useStreamStatus } from "../api/stream";
import { CMDK_OPEN_EVENT, CommandPalette } from "./CommandPalette";
import { NotificationDrawer } from "./NotificationDrawer";
import { SiteSwitcher } from "./SiteSwitcher";
import { StatusPill } from "./StatusPill";
import { useToast } from "./Toast";
import { UserMenu } from "./UserMenu";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

interface NavGroup {
  group: string;
  items: NavItem[];
}

// F1-1 information architecture: Monitor / Assets / Respond / Analyze / AI
// / Admin. r1 FA-1: groups are always open (no per-group collapse chevron)
// and their labels are sentence case, muted 12px type -- not tracked-out
// ALL CAPS, which the frontend-design skill calls out as a generated-page
// tell.
const NAV_GROUPS: NavGroup[] = [
  {
    group: "Monitor",
    items: [
      { to: "/", label: "Overview", icon: Gauge, end: true },
      { to: "/live", label: "Live", icon: Activity },
      { to: "/topology", label: "Topology", icon: ListTree },
    ],
  },
  {
    group: "Assets",
    items: [
      { to: "/devices", label: "Devices", icon: Bolt },
      { to: "/nodes", label: "Nodes", icon: Cpu },
    ],
  },
  { group: "Respond", items: [{ to: "/alerts", label: "Alerts", icon: Siren }] },
  { group: "Analyze", items: [{ to: "/analytics", label: "Energy", icon: LineChart }] },
  {
    group: "AI",
    items: [
      { to: "/ai/assistant", label: "Assistant", icon: Bot },
      { to: "/ai/insights", label: "Insights", icon: Sparkles },
      { to: "/ai/model", label: "Model lab", icon: Cpu },
    ],
  },
  {
    group: "Admin",
    items: [
      { to: "/system", label: "System", icon: Server },
      { to: "/settings", label: "Settings", icon: SlidersHorizontal },
    ],
  },
];

const ALL_ITEMS = NAV_GROUPS.flatMap((g) => g.items);
const MOBILE_PRIMARY = ["/", "/live", "/alerts", "/ai/assistant"];

export function Shell() {
  const overview_alerts = useAlerts({ status: "active" });
  const toast = useToast();
  const qc = useQueryClient();
  const streamStatus = useStreamStatus();
  const seenRef = useRef<Set<number> | null>(null);

  const invalidate = useCallback(
    (keys: string[][]) => {
      for (const key of keys) qc.invalidateQueries({ queryKey: key });
    },
    [qc],
  );
  useStreamBridge(invalidate);

  // First load: remember every currently-open alert without toasting, so a
  // page refresh doesn't replay the whole backlog as toasts.
  useEffect(() => {
    if (!overview_alerts.data) return;
    if (seenRef.current === null) {
      seenRef.current = new Set(overview_alerts.data.map((a) => a.id));
      return;
    }
    for (const a of overview_alerts.data) {
      if (seenRef.current.has(a.id)) continue;
      seenRef.current.add(a.id);
      if (a.severity === "critical" || a.severity === "warning") {
        toast.push({ title: a.title, severity: a.severity, href: `/alerts?open=${a.id}` });
      }
    }
  }, [overview_alerts.data, toast]);

  const location = useLocation();
  const [pageTitle, setPageTitle] = useState("Overview");
  const [moreOpen, setMoreOpen] = useState(false);

  const fallbackItem = useMemo(
    () => ALL_ITEMS.find((n) => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to))),
    [location.pathname],
  );
  const fallbackTitle = fallbackItem?.label ?? "WattWatch";
  const isDeviceDetail = location.pathname.startsWith("/devices/");
  const isNodeDetail = location.pathname.startsWith("/nodes/") && location.pathname !== "/nodes";
  const isDetail = isDeviceDetail || isNodeDetail;
  const title = isDetail ? pageTitle : fallbackTitle;

  const breadcrumb: { label: string; to?: string }[] = isDeviceDetail
    ? [{ label: "Devices", to: "/devices" }, { label: pageTitle }]
    : isNodeDetail
      ? [{ label: "Nodes", to: "/nodes" }, { label: pageTitle }]
      : [{ label: title }];

  return (
    <div className="flex min-h-screen bg-bg text-text">
      <aside
        data-testid="sidebar"
        className="hidden w-56 flex-col gap-3 border-r border-border bg-surface px-3 py-4 md:flex"
      >
        <div className="flex items-center gap-2 px-2">
          <Zap size={18} className="text-trace" />
          <span className="text-sm font-semibold tracking-tight">WattWatch</span>
        </div>
        <SiteSwitcher />
        <nav className="flex flex-col gap-3 overflow-y-auto">
          {NAV_GROUPS.map((g) => (
            <NavGroupSection key={g.group} group={g} />
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          data-testid="topbar"
          className="flex items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3 md:px-6"
        >
          <nav aria-label="Breadcrumb" data-testid="breadcrumbs" className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-text-muted">
            {breadcrumb.map((b, i) => (
              <span key={i} className="flex items-center gap-1.5">
                {i > 0 && <span aria-hidden>/</span>}
                {b.to ? (
                  <NavLink to={b.to} className="hover:text-text">
                    {b.label}
                  </NavLink>
                ) : (
                  <span data-testid="page-title" className="truncate text-text">
                    {b.label}
                  </span>
                )}
              </span>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="command-palette-trigger"
              onClick={() => window.dispatchEvent(new Event(CMDK_OPEN_EVENT))}
              className="hidden items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-text-muted transition-colors hover:text-text hover:bg-surface-raised sm:flex"
            >
              <CommandIcon size={12} />
              <span>K</span>
            </button>
            <StatusPill status={streamStatus} />
            <NotificationDrawer />
            <UserMenu />
          </div>
        </header>

        <main className="flex-1 overflow-x-hidden px-4 py-5 pb-20 md:px-6 md:pb-6">
          <Outlet context={{ setDeviceTitle: setPageTitle }} />
        </main>
      </div>

      <nav
        data-testid="bottom-tabs"
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-surface md:hidden"
      >
        {ALL_ITEMS.filter((n) => MOBILE_PRIMARY.includes(n.to)).map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            data-testid={`tab-${label.toLowerCase()}`}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] ${isActive ? "text-trace" : "text-text-muted"}`
            }
          >
            <Icon size={18} />
            {label}
          </NavLink>
        ))}
        <button
          type="button"
          data-testid="tab-more"
          onClick={() => setMoreOpen(true)}
          className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] text-text-muted"
        >
          <Menu size={18} />
          More
        </button>
      </nav>

      {moreOpen && (
        <div
          data-testid="mobile-more-sheet"
          className="fixed inset-0 z-50 flex items-end bg-black/50 md:hidden"
          onClick={() => setMoreOpen(false)}
          role="presentation"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="max-h-[70vh] w-full overflow-y-auto rounded-t-md border-t border-border bg-surface p-3"
          >
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-sm font-medium text-text">More</span>
              <button type="button" aria-label="Close" onClick={() => setMoreOpen(false)} className="rounded-md p-1 text-text-muted hover:bg-surface-raised">
                <X size={16} />
              </button>
            </div>
            {NAV_GROUPS.map((g) => (
              <div key={g.group} className="mb-2">
                <div className="px-2 py-1 text-xs text-text-muted">{g.group}</div>
                {g.items
                  .filter((n) => !MOBILE_PRIMARY.includes(n.to))
                  .map(({ to, label, icon: Icon, end }) => (
                    <NavLink
                      key={to}
                      to={to}
                      end={end}
                      onClick={() => setMoreOpen(false)}
                      data-testid={`more-${label.toLowerCase().replace(/\s+/g, "-")}`}
                      className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-text transition-colors hover:bg-surface-raised"
                    >
                      <Icon size={16} />
                      {label}
                    </NavLink>
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <CommandPalette />
    </div>
  );
}

function NavGroupSection({ group }: { group: NavGroup }) {
  // r1 FA-1: groups are always open -- no collapse state, no chevron, no
  // click handler. The label is sentence case (set once in NAV_GROUPS
  // above) in muted 12px type, not an ALL-CAPS eyebrow.
  return (
    <div>
      <div data-testid={`nav-group-${group.group.toLowerCase()}`} className="px-2 py-1 text-xs font-medium text-text-muted">
        {group.group}
      </div>
      <div className="flex flex-col gap-0.5">
        {group.items.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            data-testid={`nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
            className={({ isActive }) =>
              `flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors ${
                isActive ? "bg-surface-raised text-trace" : "text-text-muted hover:bg-surface-raised hover:text-text"
              }`
            }
          >
            <Icon size={16} />
            {label}
          </NavLink>
        ))}
      </div>
    </div>
  );
}
