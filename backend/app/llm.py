"""LLM client factory.

A single ``get_llm()`` function returns a configured LangChain chat model based
on environment variables. The factory is wrapped in ``functools.lru_cache`` so
we instantiate the underlying HTTP client exactly once per process (Singleton
behavior at module scope) -- this matters because LangChain's chat models hold
an internal ``httpx.AsyncClient`` whose TCP connection pool is best reused.
"""
from __future__ import annotations

import os
from functools import lru_cache

from langchain_core.language_models import BaseChatModel


@lru_cache(maxsize=4)
def _build_llm(provider: str, model: str, temperature: float, timeout: float) -> BaseChatModel:
    """Construct a LangChain chat model for the given provider.

    Imports are deferred so a missing optional dependency for one provider
    does not break the other. This keeps the dependency graph at startup
    minimal -- only the chosen provider is loaded.
    """
    provider_norm = provider.lower().strip()
    if provider_norm == "anthropic":
        from langchain_anthropic import ChatAnthropic

        return ChatAnthropic(
            model_name=model,
            temperature=temperature,
            timeout=timeout,
            stop=None,
        )
    from langchain_openai import ChatOpenAI

    return ChatOpenAI(
        model=model,
        temperature=temperature,
        timeout=timeout,
    )


def get_llm() -> BaseChatModel:
    """Return the process-wide chat model, configured from env vars.

    Recognized variables:
        * ``LLM_PROVIDER``       -- ``openai`` (default) or ``anthropic``
        * ``LLM_MODEL``          -- model name; falls back to a sensible default
        * ``LLM_TEMPERATURE``    -- float, defaults to ``0.1``
        * ``LLM_TIMEOUT_SECONDS``-- float, defaults to ``60``
    """
    provider = os.getenv("LLM_PROVIDER", "openai")
    default_model = (
        "claude-3-5-sonnet-latest" if provider.lower() == "anthropic" else "gpt-4o-mini"
    )
    model = os.getenv("LLM_MODEL", default_model)
    temperature = float(os.getenv("LLM_TEMPERATURE", "0.1"))
    timeout = float(os.getenv("LLM_TIMEOUT_SECONDS", "60"))
    return _build_llm(provider, model, temperature, timeout)
