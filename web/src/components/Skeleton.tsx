export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      data-testid="skeleton"
      className={`animate-pulse rounded-md bg-surface-raised ${className}`}
      aria-hidden
    />
  );
}
