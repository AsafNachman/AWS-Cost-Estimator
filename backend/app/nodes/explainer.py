"""LangGraph node #4: ``architecture_explainer``.

Produces a beautifully structured Markdown analysis of the architecture,
grouped by concern (Compute, Storage, Networking, Security, Analytics,
Observability), and weaves in the cost numbers so the explanation and the
estimate read as one document.

Why no structured output here?
------------------------------
The explanation's value is its prose and Markdown formatting. Forcing a JSON
schema would constrain layout in ways the user does not need; we simply ask
the LLM for Markdown and pass the string through.
"""
from __future__ import annotations

import logging
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.prompts import ChatPromptTemplate

from ..llm import get_llm
from ..state import CostEstimateItem, ExtractedResource, OverallState

logger = logging.getLogger(__name__)


def _classify_edge(edge: dict[str, Any]) -> str:
    """Bucket an edge by visual semantics, per the assignment spec."""
    style = edge.get("style") or {}
    if isinstance(style, dict) and style.get("strokeDasharray"):
        return "cross-cutting"
    if edge.get("animated"):
        return "live-data-flow"
    return "operational"


def _serialize_resource(r: ExtractedResource) -> dict[str, Any]:
    return {
        "id": r.id,
        "title": r.title,
        "service": r.canonical_service,
        "account": r.account,
        "region": r.region,
        "availability_zone": r.availability_zone,
        "instance": (
            r.instance_type
            or r.db_instance_class
            or r.cache_node_type
            or r.warehouse_node_type
        ),
        "count": r.count,
        "max_count": r.max_count,
        "multi_az": r.multi_az,
        "engine": r.engine,
        "role": r.role,
    }


def _serialize_cost(c: CostEstimateItem) -> dict[str, Any]:
    return {
        "resource_id": c.resource_id,
        "title": c.title,
        "service": c.service,
        "monthly_cost_usd": c.monthly_cost_usd,
        "confidence": c.confidence,
    }


_SYSTEM_PROMPT = """You are a principal AWS solutions architect writing an executive-ready
architectural review of a customer's infrastructure diagram. Output **Markdown**.

The diagram uses three visual conventions for edges:
- **Animated solid lines** = live data flow (requests, queries, streaming).
- **Non-animated solid lines** = operational relationships (deployments, backups, log collection).
- **Dashed lines (`strokeDasharray`)** = cross-cutting concerns (encryption with KMS,
  WAF inspection, monitoring/audit collection, compliance integrations).

Produce a polished Markdown document with the following sections, in this order:

# Architecture Overview
> A short, italicized one-liner summary.

## TL;DR
A 3-5 bullet summary covering: workload purpose, multi-account strategy, primary risk areas,
estimated monthly cost (use the total provided), and the dominant cost driver.

## Compute
- Group by account (Production / Management / Deployment / Dev/QA / Global).
- For each compute resource, name the service, instance class, count (and scaling range if any),
  and a one-sentence purpose.
- Call out multi-AZ deployments and Blue/Green or scaling strategies.

## Storage
- Aurora / Redshift / S3 / EFS / EBS. Mention encryption posture, retention, durability.

## Networking
- ALB / CloudFront / Route 53 / Transit Gateway / NAT / Internet Gateway / PrivateLink / VPC topology.
- Explain the traffic path from user to application.

## Security & Compliance
- WAF, Shield, KMS, Secrets Manager, GuardDuty, Security Hub, Inspector, CloudTrail, IAM/SSO.
- Explicitly cite the dashed edges and what they encrypt / inspect / collect.

## Analytics
- Kinesis Firehose, Redshift, Glue, Athena, QuickSight pipeline.
- Describe the data flow from ingest -> warehouse -> BI.

## Observability
- CloudWatch, X-Ray, DataDog, SNS alerts.

## Architectural Patterns Observed
- Bullet list of named patterns (e.g. Landing Zone, multi-account isolation, hub-and-spoke via
  Transit Gateway, cache-aside via ElastiCache, write-once-read-many via Aurora replicas, etc.).

## Notable Risks & Recommendations
- 3-5 punchy bullets on what could be improved (cost, reliability, security).

Formatting requirements:
- Use proper Markdown headings, bullet lists, **bold** for service names, `code` for instance types.
- Keep paragraphs short. Prefer bullets over prose.
- Do **not** invent resources that are not in the input.
- Reference resources by their `title` field when naming them in the prose.
"""


async def architecture_explainer(state: OverallState) -> dict[str, Any]:
    """LangGraph node: generate the Markdown architectural analysis."""
    resources: list[ExtractedResource] = list(state.get("parsed_resources") or [])
    final_costs: list[CostEstimateItem] = list(state.get("final_costs") or [])
    total_cost: float = float(state.get("total_monthly_cost") or 0.0)
    diagram: dict[str, Any] = state.get("raw_diagram") or {}
    edges: list[dict[str, Any]] = list(diagram.get("edges") or [])

    if not resources:
        return {
            "architectural_explanation": (
                "# Architecture Overview\n\n"
                "_No billable resources were detected in the supplied diagram._"
            )
        }

    classified_edges = [
        {
            "source": e.get("source"),
            "target": e.get("target"),
            "label": e.get("label"),
            "category": _classify_edge(e),
        }
        for e in edges
        if isinstance(e, dict)
    ]

    llm = get_llm()
    prompt = ChatPromptTemplate.from_messages(
        [
            SystemMessage(content=_SYSTEM_PROMPT),
            HumanMessage(
                content=(
                    f"Total monthly cost (us-east-1 on-demand): "
                    f"**${total_cost:,.2f}/month**\n\n"
                    "Resources:\n"
                    f"{[_serialize_resource(r) for r in resources]}\n\n"
                    "Cost summary (per resource):\n"
                    f"{[_serialize_cost(c) for c in final_costs]}\n\n"
                    "Edges (categorized):\n"
                    f"{classified_edges}\n\n"
                    "Diagram name: "
                    f"{diagram.get('name')!r}"
                )
            ),
        ]
    )

    try:
        message = await (prompt | llm).ainvoke({})
        content = message.content
        markdown = content if isinstance(content, str) else str(content)
    except Exception as exc:  # noqa: BLE001
        logger.exception("explainer: LLM call failed")
        markdown = (
            "# Architecture Overview\n\n"
            f"_LLM explanation unavailable: {exc}_\n\n"
            f"Total estimated monthly cost: **${total_cost:,.2f}**."
        )

    logger.info("explainer: produced %d chars of Markdown", len(markdown))
    return {"architectural_explanation": markdown}
