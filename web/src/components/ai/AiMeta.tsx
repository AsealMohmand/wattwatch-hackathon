import { Cpu } from "lucide-react";

/** Muted footer line under an AI answer: which model answered, how long it
 * took, and whether it's a template fallback rather than a model answer. */
export function AiMeta({
  model,
  latencyMs,
  fallback,
}: {
  model: string;
  latencyMs?: number | null;
  fallback?: boolean;
}) {
  return (
    <span data-testid="ai-meta" className="flex flex-col gap-1 text-xs text-text-muted">
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <Cpu size={11} aria-hidden />
        <span className="font-mono-nums">{model}</span>
        {latencyMs != null && <span className="font-mono-nums">{latencyMs.toLocaleString()} ms</span>}
      </span>
      {fallback && <span data-testid="ai-fallback-note">Template explanation. Llama didn't answer in time.</span>}
    </span>
  );
}
