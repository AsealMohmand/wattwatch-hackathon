// Insights (/ai/insights) — F2-2. A daily-digest timeline with a "Generate
// now" button, plus a per-incident AI explanation feed (appliance guess,
// confidence meter, verdict chip, model + latency).
import { AlarmClock, FileClock, Loader2, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import type { Explanation } from "../../api/client";
import { ApiError } from "../../api/client";
import { useGenerateDigest, useIncidents, useInsights } from "../../api/hooks";
import { AiMeta } from "../../components/ai/AiMeta";
import { ConfidenceMeter } from "../../components/ai/ConfidenceMeter";
import { VerdictChip } from "../../components/ai/VerdictChip";
import { EmptyState } from "../../components/EmptyState";
import { Skeleton } from "../../components/Skeleton";
import { formatDateTime, formatDuration, formatRelative, formatWatts } from "../../lib/format";

export function Insights() {
  const insights = useInsights(20);
  const incidents = useIncidents({ limit: 20 });
  const incidentRows = incidents.data ?? [];
  const generate = useGenerateDigest();
  const [genError, setGenError] = useState<string | null>(null);

  const digests = useMemo(() => (insights.data ?? []).filter((i) => i.kind === "daily_digest"), [insights.data]);

  function handleGenerate() {
    setGenError(null);
    generate.mutate(undefined, {
      onError: (err: unknown) => {
        setGenError(
          err instanceof ApiError && err.status === 503
            ? "The local model isn't reachable, so a new digest can't be written right now."
            : "Couldn't generate a digest. Try again in a moment.",
        );
      },
    });
  }

  return (
    <div data-testid="page-ai-insights" className="flex flex-col gap-6">
      <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-text">Daily digests</h2>
          <button
            type="button"
            data-testid="generate-digest"
            disabled={generate.isPending}
            onClick={handleGenerate}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-text transition-colors hover:border-trace disabled:cursor-not-allowed disabled:opacity-60"
          >
            {generate.isPending ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {generate.isPending ? "Generating…" : "Generate now"}
          </button>
        </div>
        {genError && (
          <p className="text-xs text-critical" data-testid="digest-error">
            {genError}
          </p>
        )}

        {insights.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : digests.length > 0 ? (
          <ul data-testid="digest-timeline" className="flex flex-col gap-3">
            {digests.map((d) => (
              <li key={d.id} data-testid="digest-card" className="flex flex-col gap-1.5 rounded-md border border-border bg-bg px-3 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium text-text">{d.title}</h3>
                  <span className="font-mono-nums text-xs text-text-muted">{formatRelative(d.created_ts)}</span>
                </div>
                <p className="text-sm text-text-muted">{d.body}</p>
                {d.model && <AiMeta model={d.model} latencyMs={d.latency_ms} />}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={FileClock}
            title="No digests yet."
            detail="A few sentences on your energy use will appear here once a digest runs, or generate the first one now."
            testId="digest-empty"
          />
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
        <h2 className="text-sm font-medium text-text">Incident explanations</h2>
        {incidents.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : incidentRows.length > 0 ? (
          <ul data-testid="incident-explanation-feed" className="flex flex-col gap-2">
            {incidentRows.map((inc) => (
              <li key={inc.id} data-testid="incident-explanation-row" className="flex flex-col gap-1.5 rounded-md border border-border px-3 py-2.5 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="font-mono-nums text-text-muted">{formatDateTime(inc.start_ts)}</span>
                  <span className="flex flex-wrap items-center gap-3 text-text-muted">
                    <span>{inc.device_name}</span>
                    <span>Peak {formatWatts(inc.peak_w)}</span>
                    <span>Duration {formatDuration(inc.duration_s)}</span>
                  </span>
                </div>
                {inc.ai ? <StructuredExplanation ai={inc.ai} /> : <PlainExplanation explanation={inc.explanation} />}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={AlarmClock}
            title="No incidents yet."
            detail="Spikes and unusual patterns will get an AI explanation here as they happen."
            testId="incidents-empty"
          />
        )}
      </section>
    </div>
  );
}

function StructuredExplanation({ ai }: { ai: Explanation }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-text">{ai.appliance ?? "Unidentified load"}</span>
        {ai.confidence && <ConfidenceMeter confidence={ai.confidence} />}
        {ai.verdict && <VerdictChip verdict={ai.verdict} />}
      </div>
      <p className="text-text-muted">{ai.summary}</p>
      <AiMeta model={ai.model} latencyMs={ai.latency_ms} fallback={ai.fallback} />
    </>
  );
}

function PlainExplanation({ explanation }: { explanation: string | null }) {
  return <p className="text-text-muted">{explanation ?? "Explaining…"}</p>;
}
