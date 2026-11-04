"""Thin shared client for the local Ollama server.

Every ML module (explain, assistant, digest, eval_explain) calls `chat` or
`chat_stream` here instead of talking to Ollama directly, so the model name,
URL, timeouts and keep-alive policy live in one place.

    127.0.0.1, not localhost: on Windows, localhost resolves IPv6 first and
    adds ~2 s per call.
"""

import json
import os
import time
from typing import Iterator

import requests

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2:3b")
KEEP_ALIVE = "60m"  # keep the model loaded; a cold 3b load alone takes ~20 s


def chat(messages: list[dict], model: str | None = None, format: dict | str | None = None,
         timeout: float = 20, options: dict | None = None) -> tuple[str, int]:
    """One non-streaming call. Returns (text, latency_ms); raises on error or empty reply."""
    body = {
        "model": model or MODEL,
        "stream": False,
        "keep_alive": KEEP_ALIVE,
        "messages": messages,
        "options": {"temperature": 0.2, "num_predict": 200, **(options or {})},
    }
    if format is not None:
        body["format"] = format
    t0 = time.monotonic()
    r = requests.post(f"{OLLAMA_URL}/api/chat", json=body, timeout=timeout)
    r.raise_for_status()
    latency_ms = int((time.monotonic() - t0) * 1000)
    text = r.json()["message"]["content"].strip()
    if not text:
        raise ValueError("empty reply")
    return text, latency_ms


def chat_stream(messages: list[dict], model: str | None = None, timeout: float = 60) -> Iterator[str]:
    """Stream tokens (message.content chunks) from Ollama. Raises on error."""
    body = {
        "model": model or MODEL,
        "stream": True,
        "keep_alive": KEEP_ALIVE,
        "messages": messages,
        "options": {"temperature": 0.2, "num_predict": 300},
    }
    with requests.post(f"{OLLAMA_URL}/api/chat", json=body, timeout=timeout, stream=True) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if not line:
                continue
            chunk = json.loads(line)
            piece = chunk.get("message", {}).get("content")
            if piece:
                yield piece
            if chunk.get("done"):
                break


def reachable(timeout: float = 1.0) -> bool:
    try:
        r = requests.get(f"{OLLAMA_URL}/api/tags", timeout=timeout)
        return r.status_code == 200
    except Exception:
        return False
