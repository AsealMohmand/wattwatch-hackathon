/** Small filled badge naming which detector flagged an incident/event:
 * "Rule" (the fixed-threshold layer) or "ML" (the Isolation Forest layer). */
export function MethodChip({ method }: { method: "rule" | "iforest" }) {
  return (
    <span
      data-testid="method-chip"
      data-method={method}
      className={`rounded px-1.5 py-0.5 text-xs ${method === "rule" ? "bg-critical-bg text-critical" : "bg-info-bg text-info"}`}
    >
      {method === "rule" ? "Rule" : "ML"}
    </span>
  );
}
