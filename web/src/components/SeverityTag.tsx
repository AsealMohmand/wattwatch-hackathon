import { AlertTriangle, Info, OctagonAlert } from "lucide-react";
import type { AlertSeverity } from "../api/client";

const CONFIG: Record<AlertSeverity, { label: string; icon: typeof Info; text: string; bg: string }> = {
  info: { label: "Info", icon: Info, text: "text-info", bg: "bg-info-bg" },
  warning: { label: "Warning", icon: AlertTriangle, text: "text-warning", bg: "bg-warning-bg" },
  critical: { label: "Critical", icon: OctagonAlert, text: "text-critical", bg: "bg-critical-bg" },
};

export function SeverityTag({ severity }: { severity: AlertSeverity }) {
  // Defensive: never let a transient/malformed value crash the tree —
  // fall back to "info" styling rather than destructuring undefined.
  const { label, icon: Icon, text, bg } = CONFIG[severity] ?? CONFIG.info;
  return (
    <span
      data-testid="severity-tag"
      data-severity={severity}
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${text} ${bg}`}
    >
      <Icon size={12} aria-hidden />
      {label}
    </span>
  );
}

/** Outlined chip shown after an alert's title when both detectors fired on
 * the same incident — tells the user one thing happened, caught twice. */
export function DetectorsChip({ detectors }: { detectors?: string[] | null }) {
  if (!detectors?.includes("rule") || !detectors.includes("iforest")) return null;
  return (
    <span
      data-testid="detectors-chip"
      className="inline-flex shrink-0 items-center rounded-md border border-info px-1.5 py-0.5 text-[10px] font-medium text-info"
    >
      Rule + ML
    </span>
  );
}
