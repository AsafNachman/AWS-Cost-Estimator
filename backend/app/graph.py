"""LangGraph compilation and module-level singleton.

The graph is a strict linear pipeline:

    START -> parse -> enrich -> estimate -> explain -> END

We compile once at import time and reuse the compiled object across requests.
Compiling a ``StateGraph`` builds internal node-lookup tables and topology
caches; doing it per-request would be wasteful.
"""
from __future__ import annotations

import logging
from typing import Any

from langgraph.graph import END, START, StateGraph

from .nodes.enricher import infracost_lookup
from .nodes.estimator import llm_cost_aggregator
from .nodes.explainer import architecture_explainer
from .nodes.parser import parse_and_contextualize
from .state import OverallState

logger = logging.getLogger(__name__)


def build_graph() -> Any:
    """Construct, wire, and compile the cost-estimator LangGraph."""
    workflow: StateGraph = StateGraph(OverallState)

    workflow.add_node("parse", parse_and_contextualize)
    workflow.add_node("enrich", infracost_lookup)
    workflow.add_node("estimate", llm_cost_aggregator)
    workflow.add_node("explain", architecture_explainer)

    workflow.add_edge(START, "parse")
    workflow.add_edge("parse", "enrich")
    workflow.add_edge("enrich", "estimate")
    workflow.add_edge("estimate", "explain")
    workflow.add_edge("explain", END)

    compiled = workflow.compile()
    logger.info("graph: compiled (parse -> enrich -> estimate -> explain)")
    return compiled


compiled_graph = build_graph()
"""Process-wide compiled pipeline. Reused across requests."""
