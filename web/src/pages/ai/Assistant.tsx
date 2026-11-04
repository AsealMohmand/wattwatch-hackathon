// "Ask WattWatch" (/ai/assistant) — F2-1. Streams tokens from
// POST /api/assistant via fetch + a ReadableStream reader (EventSource can't
// POST), with suggested-prompt chips, a muted model/latency footer, a
// collapsible "Data used" list, a stop button, and retry on error. History
// is kept for the browser session (sessionStorage), not across devices.
import { AlertCircle, CornerDownLeft, RotateCcw, Send, Sparkles, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client";
import { askAssistant } from "../../api/ai";
import type { AssistantMessage } from "../../api/ai";
import { AiMeta } from "../../components/ai/AiMeta";
import { DataUsedList } from "../../components/ai/DataUsedList";
import { EmptyState } from "../../components/EmptyState";

const SUGGESTED = [
  "What used the most energy today?",
  "Is anything running that shouldn't be?",
  "What will my bill be this month?",
  "Explain the last spike",
];

const STORAGE_KEY = "ww-assistant-history";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  model?: string;
  latencyMs?: number | null;
  contextKeys?: string[];
  error?: string;
}

function loadHistory(): ChatMessage[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatMessage[];
    return Array.isArray(parsed) ? parsed.filter((m) => !m.streaming && !m.error) : [];
  } catch {
    return [];
  }
}

function saveHistory(messages: ChatMessage[]) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  } catch {
    // sessionStorage unavailable (private mode, etc.) -- history just won't persist
  }
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `m${Date.now()}-${idCounter}`;
}

export function Assistant() {
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadHistory());
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => saveHistory(messages), [messages]);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  function send(question: string) {
    const trimmed = question.trim();
    if (!trimmed || sending) return;

    const history: AssistantMessage[] = messages.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));

    const userMsg: ChatMessage = { id: nextId(), role: "user", content: trimmed };
    const assistantId = nextId();
    const assistantMsg: ChatMessage = { id: assistantId, role: "assistant", content: "", streaming: true };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput("");
    setSending(true);

    const controller = new AbortController();
    abortRef.current = controller;

    askAssistant(trimmed, history, controller.signal, (token) => {
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + token } : m)));
    })
      .then((done) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, streaming: false, model: done.model, latencyMs: done.latency_ms, contextKeys: done.context_keys }
              : m,
          ),
        );
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) {
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)));
          return;
        }
        const message =
          err instanceof ApiError
            ? err.status === 503
              ? "The local model isn't reachable right now."
              : err.message
            : err instanceof Error
              ? err.message
              : "Something went wrong.";
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, streaming: false, error: message } : m)));
      })
      .finally(() => {
        setSending(false);
        abortRef.current = null;
      });
  }

  function stop() {
    abortRef.current?.abort();
  }

  function retry(userContent: string, assistantId: string) {
    setMessages((prev) => prev.filter((m) => m.id !== assistantId));
    send(userContent);
  }

  return (
    <div data-testid="page-ai-assistant" className="flex h-full min-h-[70vh] flex-col gap-4">
      <div ref={listRef} data-testid="chat-log" className="flex flex-1 flex-col gap-4 overflow-y-auto pb-2">
        {messages.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title="Ask about your own energy data."
            detail="Answers come only from what WattWatch has recorded here, processed locally by Llama 3.2 — nothing leaves this machine."
            testId="assistant-empty"
          />
        ) : (
          messages.map((m, i) => {
            const prevUser = i > 0 ? messages[i - 1] : null;
            return (
              <div key={m.id} data-testid={`chat-message-${m.role}`} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`flex max-w-[85%] flex-col gap-1.5 rounded-md border border-border px-3 py-2 text-sm ${
                    m.role === "user" ? "bg-surface-raised text-text" : "bg-surface text-text"
                  }`}
                >
                  {m.content ? (
                    <p className="whitespace-pre-wrap">{m.content}</p>
                  ) : m.streaming ? (
                    <span className="flex items-center gap-1.5 text-text-muted" data-testid="assistant-thinking">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-muted" />
                      Thinking…
                    </span>
                  ) : null}
                  {m.error && (
                    <div data-testid="chat-error" className="flex flex-wrap items-center gap-2 text-xs text-critical">
                      <AlertCircle size={13} />
                      <span>{m.error}</span>
                      {prevUser && (
                        <button
                          type="button"
                          data-testid="chat-retry"
                          onClick={() => retry(prevUser.content, m.id)}
                          className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-text-muted transition-colors hover:text-text"
                        >
                          <RotateCcw size={11} />
                          Retry
                        </button>
                      )}
                    </div>
                  )}
                  {m.role === "assistant" && !m.streaming && !m.error && m.model && (
                    <div className="flex flex-col gap-1 border-t border-border pt-1.5">
                      <AiMeta model={m.model} latencyMs={m.latencyMs} />
                      <DataUsedList keys={m.contextKeys ?? []} />
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="flex flex-wrap gap-2" data-testid="suggested-prompts">
        {SUGGESTED.map((p) => (
          <button
            key={p}
            type="button"
            data-testid="suggested-prompt"
            disabled={sending}
            onClick={() => send(p)}
            className="rounded-md border border-border px-2.5 py-1.5 text-xs text-text-muted transition-colors hover:border-trace hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            {p}
          </button>
        ))}
      </div>

      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <textarea
          data-testid="assistant-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          placeholder="Ask about your energy use…"
          rows={1}
          className="flex-1 resize-none rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:outline-none"
        />
        {sending ? (
          <button
            type="button"
            data-testid="assistant-stop"
            onClick={stop}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm text-text transition-colors hover:bg-surface-raised"
          >
            <Square size={14} />
            Stop
          </button>
        ) : (
          <button
            type="submit"
            data-testid="assistant-send"
            disabled={!input.trim()}
            className="flex items-center gap-1.5 rounded-md bg-trace px-3 py-2 text-sm font-medium text-[#0b1612] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send size={14} />
            Send
          </button>
        )}
      </form>
      <p className="flex items-center gap-1 text-[11px] text-text-muted">
        <CornerDownLeft size={11} />
        Enter to send, shift+Enter for a new line.
      </p>
    </div>
  );
}
