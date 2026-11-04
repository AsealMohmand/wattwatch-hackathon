import type { LucideIcon } from "lucide-react";

/** An empty state tells the user what will appear here and why it's empty
 * right now — never just "No data." */
export function EmptyState({
  icon: Icon,
  title,
  detail,
  testId,
}: {
  icon: LucideIcon;
  title: string;
  detail?: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId ?? "empty-state"}
      className="flex flex-col items-center gap-2 px-6 py-12 text-center text-text-muted"
    >
      <Icon size={28} strokeWidth={1.5} aria-hidden />
      <p className="text-sm text-text">{title}</p>
      {detail && <p className="max-w-sm text-xs">{detail}</p>}
    </div>
  );
}
