// F1-1: global command palette (Ctrl/Cmd+K). Jump to any page, device or
// node, or run one of a handful of actions that would otherwise need a
// trip through a form. Mounted once in Shell; a topbar button dispatches
// the same "ww:cmdk-open" event the keyboard shortcut does, so there's one
// source of truth for "is it open" without lifting state into Shell.
import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, encodeDeviceId } from "../api/client";
import { useAlerts, useDevices, useGenerateDigest, useNodes, useTrainModel } from "../api/hooks";
import { useToast } from "./Toast";

export const CMDK_OPEN_EVENT = "ww:cmdk-open";

const PAGES = [
  { label: "Overview", to: "/" },
  { label: "Live", to: "/live" },
  { label: "Topology", to: "/topology" },
  { label: "Devices", to: "/devices" },
  { label: "Nodes", to: "/nodes" },
  { label: "Alerts", to: "/alerts" },
  { label: "Energy analytics", to: "/analytics" },
  { label: "Assistant", to: "/ai/assistant" },
  { label: "Insights", to: "/ai/insights" },
  { label: "Model lab", to: "/ai/model" },
  { label: "System", to: "/system" },
  { label: "Settings", to: "/settings" },
];

const ITEM_CLASS =
  "cursor-pointer rounded px-2.5 py-2 text-sm text-text data-[selected=true]:bg-surface-raised data-[selected=true]:text-trace";
const GROUP_CLASS = "text-xs text-text-muted [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const devices = useDevices();
  const nodes = useNodes();
  const infoAlerts = useAlerts({ status: "open", severity: "info" });
  const generateDigest = useGenerateDigest();
  const trainModel = useTrainModel();
  const toast = useToast();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    function onOpenEvent() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(CMDK_OPEN_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(CMDK_OPEN_EVENT, onOpenEvent);
    };
  }, []);

  function go(to: string) {
    setOpen(false);
    navigate(to);
  }

  async function ackAllInfo() {
    setOpen(false);
    const targets = infoAlerts.data ?? [];
    await Promise.all(targets.map((a) => api.ackAlert(a.id).catch(() => undefined)));
    toast.push({
      title: targets.length > 0 ? `Acknowledged ${targets.length} info alert${targets.length === 1 ? "" : "s"}` : "No open info alerts",
      severity: "info",
      href: "/alerts",
    });
  }

  function generateDigestNow() {
    setOpen(false);
    generateDigest.mutate(undefined, {
      onSuccess: () => toast.push({ title: "Digest generated", severity: "info", href: "/ai/insights" }),
      onError: () => toast.push({ title: "Couldn't generate a digest right now", severity: "warning", href: "/ai/insights" }),
    });
  }

  function retrainNow() {
    setOpen(false);
    trainModel.mutate(undefined, {
      onSuccess: () => toast.push({ title: "Retraining started", severity: "info", href: "/ai/model" }),
      onError: () => toast.push({ title: "Couldn't start training right now", severity: "warning", href: "/ai/model" }),
    });
  }

  function exportReadings() {
    setOpen(false);
    window.open(api.readingsCsvUrl({}), "_blank");
  }

  if (!open) return null;

  return (
    <div
      data-testid="command-palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[12vh]"
      onClick={() => setOpen(false)}
      role="presentation"
    >
      <Command
        shouldFilter
        loop
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded border border-border bg-surface shadow-xl"
      >
        <Command.Input
          autoFocus
          placeholder="Jump to a page, device or node…"
          data-testid="command-palette-input"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm text-text outline-none placeholder:text-text-muted"
        />
        <Command.List className="max-h-80 overflow-y-auto p-1.5">
          <Command.Empty className="px-3 py-6 text-center text-sm text-text-muted">No results.</Command.Empty>
          <Command.Group heading="Pages" className={GROUP_CLASS}>
            {PAGES.map((p) => (
              <Command.Item key={p.to} value={p.label} onSelect={() => go(p.to)} className={ITEM_CLASS}>
                {p.label}
              </Command.Item>
            ))}
          </Command.Group>
          {devices.data && devices.data.length > 0 && (
            <Command.Group heading="Devices" className={GROUP_CLASS}>
              {devices.data.map((d) => (
                <Command.Item
                  key={d.device_id}
                  value={`${d.name} ${d.device_id}`}
                  onSelect={() => go(`/devices/${encodeDeviceId(d.device_id)}`)}
                  className={ITEM_CLASS}
                >
                  {d.name}
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {nodes.data && nodes.data.length > 0 && (
            <Command.Group heading="Nodes" className={GROUP_CLASS}>
              {nodes.data.map((n) => (
                <Command.Item
                  key={n.node_id}
                  value={n.node_id}
                  onSelect={() => go(`/nodes/${encodeURIComponent(n.node_id)}`)}
                  className={ITEM_CLASS}
                >
                  {n.node_id}
                </Command.Item>
              ))}
            </Command.Group>
          )}
          <Command.Group heading="Actions" className={GROUP_CLASS}>
            <Command.Item value="Acknowledge all info alerts" onSelect={ackAllInfo} className={ITEM_CLASS}>
              Acknowledge all info alerts
            </Command.Item>
            <Command.Item value="Generate digest" onSelect={generateDigestNow} className={ITEM_CLASS}>
              Generate digest
            </Command.Item>
            <Command.Item value="Retrain model" onSelect={retrainNow} className={ITEM_CLASS}>
              Retrain model
            </Command.Item>
            <Command.Item value="Export readings CSV" onSelect={exportReadings} className={ITEM_CLASS}>
              Export readings CSV
            </Command.Item>
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}
