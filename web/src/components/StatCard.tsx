export function StatCard({
  testId,
  label,
  value,
  sub,
  accent = "text",
}: {
  testId: string;
  label: string;
  value: string;
  sub?: string;
  accent?: "text" | "trace" | "copper" | "critical";
}) {
  const accentClass =
    accent === "trace" ? "text-trace" : accent === "copper" ? "text-copper" : accent === "critical" ? "text-critical" : "text-text";
  return (
    <div data-testid={testId} className="flex flex-col gap-1 rounded-md border border-border bg-surface px-4 py-3">
      <span className="text-xs text-text-muted">{label}</span>
      <span className={`font-mono-nums text-2xl font-medium ${accentClass}`}>{value}</span>
      {sub && <span className="text-xs text-text-muted">{sub}</span>}
    </div>
  );
}
