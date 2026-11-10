"""Minimal OpenAI-compatible chat client."""

from __future__ import annotations

import json
import re
import time
from typing import Optional

import httpx

from ..settings_store import Llm


class LlmError(Exception):
    pass


class LlmNotConfigured(LlmError):
    pass


def configured(cfg: Llm) -> bool:
    return bool(cfg.base_url and cfg.model)


def _url(cfg: Llm) -> str:
    base = cfg.base_url.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return f"{base}/chat/completions" if re.search(r"/v\d+$", base) else f"{base}/v1/chat/completions"


def chat(
    cfg: Llm,
    messages: list[dict],
    *,
    json_mode: bool = False,
    transport: Optional[httpx.BaseTransport] = None,
    max_tokens: Optional[int] = None,
) -> str:
    if not configured(cfg):
        raise LlmNotConfigured("LLM is not configured (base_url and model are required)")
    headers = {"Authorization": f"Bearer {cfg.api_key}"} if cfg.api_key else {}
    payload: dict = {"model": cfg.model, "messages": messages, "temperature": cfg.temperature}
    if max_tokens:
        payload["max_tokens"] = max_tokens
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    try:
        with httpx.Client(timeout=cfg.timeout_seconds, transport=transport, headers=headers) as client:
            resp = client.post(_url(cfg), json=payload)
            if json_mode and resp.status_code in (400, 422):
                # Some OpenAI-compatible servers reject response_format; retry once without it.
                payload.pop("response_format")
                resp = client.post(_url(cfg), json=payload)
    except httpx.HTTPError as exc:
        raise LlmError(f"LLM request failed: {exc}") from exc
    if resp.status_code >= 400:
        raise LlmError(f"LLM returned HTTP {resp.status_code}: {resp.text[:300]}")
    try:
        content = resp.json()["choices"][0]["message"]["content"]
    except (KeyError, IndexError, ValueError, TypeError) as exc:
        raise LlmError(f"LLM returned an unexpected response: {resp.text[:300]}") from exc
    return _strip_thinking(content or "")


_THINK = re.compile(r"<think>.*?</think>", re.DOTALL)


def _strip_thinking(text: str) -> str:
    return _THINK.sub("", text).strip()


def extract_json(text: str):
    """Pull a JSON value out of an LLM reply, tolerating code fences and surrounding prose."""
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    for opener, closer in (("{", "}"), ("[", "]")):
        start, end = text.find(opener), text.rfind(closer)
        if start != -1 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                continue
    raise LlmError("LLM reply did not contain valid JSON")


def check(cfg: Llm, transport: Optional[httpx.BaseTransport] = None) -> dict:
    if not configured(cfg):
        return {"ok": False, "detail": "LLM base_url and model are required", "latency_ms": None}
    started = time.monotonic()
    try:
        reply = chat(cfg, [{"role": "user", "content": "Reply with the single word: pong"}], transport=transport, max_tokens=16)
        return {"ok": True, "detail": reply[:80] or "ok", "latency_ms": int((time.monotonic() - started) * 1000)}
    except LlmError as exc:
        return {"ok": False, "detail": str(exc), "latency_ms": int((time.monotonic() - started) * 1000)}
