// AI-specific additions FE-2 owns on top of client.ts/hooks.ts (FE-1's
// files, which already carry the v2 model/insights/llm/explanation types,
// calls and react-query hooks — see client.ts's "v2" sections). This file
// only holds what those don't: streaming POST /api/assistant (EventSource
// can't POST, so client.ts's plain-JSON `request` doesn't cover it) and the
// appliance -> device-kind guess used by the device profile's "Use as kind"
// button.
import { ApiError } from "./client";
import type { DeviceKind } from "./client";

const BASE = "/api";

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantDone {
  latency_ms: number;
  model: string;
  context_keys: string[];
}

/** Parses a `text/event-stream` body into `{event, data}` frames. Lines
 * starting with ":" (comments/pings) are skipped; frames with no `data:`
 * line are skipped. */
async function* parseSseStream(response: Response): AsyncGenerator<{ event: string; data: string }> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event = "message";
        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;
        yield { event, data: dataLines.join("\n") };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Streams one assistant answer. Calls `onToken` for every token as it
 * arrives and resolves with the `done` payload, or throws (ApiError for a
 * non-2xx response, a plain Error for a mid-stream "error" frame or a
 * stream that ends without a result). An aborted `signal` rejects the
 * underlying fetch with a DOMException named "AbortError", which callers
 * distinguish from a real failure via `signal.aborted`. */
export async function askAssistant(
  question: string,
  history: AssistantMessage[],
  signal: AbortSignal,
  onToken: (t: string) => void,
): Promise<AssistantDone> {
  const res = await fetch(`${BASE}/assistant`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, history }),
    signal,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body?.detail) detail = body.detail;
    } catch {
      // ignore
    }
    throw new ApiError(res.status, detail);
  }
  for await (const frame of parseSseStream(res)) {
    if (frame.event === "token") {
      const payload = JSON.parse(frame.data) as { t: string };
      onToken(payload.t);
    } else if (frame.event === "done") {
      return JSON.parse(frame.data) as AssistantDone;
    } else if (frame.event === "error") {
      const payload = JSON.parse(frame.data) as { message: string };
      throw new Error(payload.message);
    }
  }
  throw new Error("The connection ended before an answer arrived.");
}

// ---- appliance -> device kind guess ---------------------------------------

const KIND_KEYWORDS: Array<[DeviceKind, string[]]> = [
  ["kettle", ["kettle", "hot water"]],
  ["heater", ["heater", "space heater"]],
  ["fridge", ["fridge", "refrigerator", "compressor"]],
  ["microwave", ["microwave"]],
  ["tv", ["tv", "television"]],
  ["washer", ["washer", "washing machine"]],
  ["dryer", ["dryer"]],
  ["computer", ["computer", "desktop", " pc"]],
  ["lighting", ["light", "lamp"]],
];

/** Maps a free-text appliance guess from the explainer to a known device
 * kind, or null when nothing matches — used by the device profile's
 * "Use as kind" button. */
export function guessDeviceKind(appliance: string): DeviceKind | null {
  const lower = ` ${appliance.toLowerCase()} `;
  for (const [kind, keywords] of KIND_KEYWORDS) {
    if (keywords.some((k) => lower.includes(k))) return kind;
  }
  return null;
}
