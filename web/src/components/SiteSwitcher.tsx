import { Check, ChevronDown, Home } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useDevices, useNodes, useSettings } from "../api/hooks";

/** F1-1: site switcher. There's exactly one site today, but the menu shape
 * (a list with a check next to the current one) is the one a second site
 * would slot into later without a redesign.
 *
 * r1 FA-1: shows a house icon, the site name, and a muted line under it
 * ("1 node, 3 devices", from the API) so this reads as a site being
 * switched, not just another page link -- the nav item right below it is
 * also labelled "Overview" now, so the two no longer collide on "Home". */
export function SiteSwitcher() {
  const settings = useSettings();
  const nodes = useNodes();
  const devices = useDevices();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const name = settings.data?.site_name ?? "Home";

  const nodeCount = nodes.data?.length ?? 0;
  const deviceCount = devices.data?.length ?? 0;
  const subtitle = nodes.data && devices.data ? `${nodeCount} node${nodeCount === 1 ? "" : "s"}, ${deviceCount} device${deviceCount === 1 ? "" : "s"}` : null;

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
        data-testid="site-switcher"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-text transition-colors hover:bg-surface-raised"
      >
        <Home size={14} className="shrink-0 text-text-muted" />
        <span className="flex min-w-0 flex-col items-start">
          <span className="truncate">{name}</span>
          {subtitle && <span data-testid="site-switcher-subtitle" className="truncate text-[11px] text-text-muted">{subtitle}</span>}
        </span>
        <ChevronDown size={12} className="ml-auto shrink-0 text-text-muted" />
      </button>
      {open && (
        <div
          data-testid="site-switcher-menu"
          className="absolute left-0 top-10 z-40 w-48 rounded-md border border-border bg-surface p-1.5 shadow-xl"
        >
          <div className="flex items-center justify-between rounded bg-surface-raised px-2.5 py-2 text-sm text-text">
            <span className="flex min-w-0 flex-col items-start">
              <span className="truncate">{name}</span>
              {subtitle && <span className="truncate text-[11px] text-text-muted">{subtitle}</span>}
            </span>
            <Check size={14} className="shrink-0 text-trace" />
          </div>
        </div>
      )}
    </div>
  );
}
