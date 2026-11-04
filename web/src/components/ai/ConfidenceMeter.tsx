import type { AiConfidence } from "../../api/client";

const LEVEL: Record<AiConfidence, number> = { low: 1, medium: 2, high: 3 };
const LABEL: Record<AiConfidence, string> = { low: "Low confidence", medium: "Medium confidence", high: "High confidence" };

/** 1/2/3 filled segments for low/medium/high, always paired with the word
 * (never color alone) so it survives grayscale. */
export function ConfidenceMeter({ confidence }: { confidence: AiConfidence }) {
  const filled = LEVEL[confidence] ?? 1;
  const label = LABEL[confidence] ?? confidence;
  return (
    <span data-testid="confidence-meter" data-confidence={confidence} className="inline-flex items-center gap-1.5">
      <span className="flex items-center gap-0.5" aria-hidden>
        {[1, 2, 3].map((i) => (
          <span key={i} className={`h-1.5 w-3 rounded-sm ${i <= filled ? "bg-info" : "bg-border"}`} />
        ))}
      </span>
      <span className="text-xs text-text-muted">{label}</span>
    </span>
  );
}
