import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { AiVerdict } from "../../api/client";

/** "Normal" / "Worth checking" — reuses the warning hue for "check" since
 * that's the same functional meaning (needs attention) as elsewhere in the
 * app, not a new decorative color. */
export function VerdictChip({ verdict }: { verdict: AiVerdict }) {
  const isNormal = verdict === "normal";
  const Icon = isNormal ? CheckCircle2 : AlertTriangle;
  return (
    <span
      data-testid="verdict-chip"
      data-verdict={verdict}
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${
        isNormal ? "border border-trace text-trace" : "text-warning bg-warning-bg"
      }`}
    >
      <Icon size={12} aria-hidden />
      {isNormal ? "Normal" : "Worth checking"}
    </span>
  );
}
