import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

const LABELS: Record<string, string> = {
  site: "Site name",
  devices: "Devices: usage, cost, peak",
  nodes: "Node health",
  incidents: "Recent incidents",
  alerts: "Open alerts",
  hourly_kwh: "Hourly energy today",
  totals: "Yesterday and month-to-date totals",
  price: "Price per kWh",
  co2_factor: "CO2 factor",
  model_status: "Model status",
};

/** Collapsible "Data used" disclosure under an assistant answer — turns raw
 * `context_keys` into plain language instead of showing the field names. */
export function DataUsedList({ keys }: { keys: string[] }) {
  const [open, setOpen] = useState(false);
  if (keys.length === 0) return null;
  return (
    <div data-testid="data-used" className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-xs text-text-muted transition-colors hover:text-text"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        Data used ({keys.length})
      </button>
      {open && (
        <ul className="ml-4 flex flex-col gap-0.5 text-xs text-text-muted">
          {keys.map((k) => (
            <li key={k}>{LABELS[k] ?? k}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
