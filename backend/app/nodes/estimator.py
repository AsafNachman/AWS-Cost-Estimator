"""LangGraph node #3: ``llm_cost_aggregator``.

Joins ``parsed_resources`` with ``infracost_results`` to produce the final
``CostEstimateItem`` list and total monthly cost.

Strategy
--------
Resources are split into two buckets:

1. **Infracost-priceable compute** (anything with a SKU resolved by the
   pricing matrix). We compute monthly cost deterministically from
   ``hourly_usd * count * 730``. No LLM. Confidence = ``High (Infracost)``.

2. **Usage-driven / unpriced** (S3, EFS, Glue, Athena, Firehose, CloudFront,
   NAT GW, ALB, KMS, etc., plus anything Infracost couldn't price). These
   we hand to the LLM in a single batched ``with_structured_output`` call.
   Confidence is ``Medium`` (defaults assumed) or ``Low`` (workload-driven).

This hybrid keeps the LLM where it adds value (probabilistic reasoning) and
keeps deterministic math where it belongs (arithmetic).

Time:  O(R_priced) + O(1) LLM call covering R_llm resources.
Space: O(R) for the produced cost list.
"""
from __future__ import annotations

import logging
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.prompts import ChatPromptTemplate
from pydantic import BaseModel, ConfigDict, Field

from ..llm import get_llm
from ..state import (
    ConfidenceLevel,
    CostEstimateItem,
    EnvironmentTier,
    ExtractedResource,
    OverallState,
)

logger = logging.getLogger(__name__)

HOURS_PER_MONTH = 730.0


# ---------------------------------------------------------------------------
# Structured-output schema for the LLM batch call.
# ---------------------------------------------------------------------------


class _LLMCostItem(BaseModel):
    """One line item returned by the LLM."""

    model_config = ConfigDict(extra="ignore")

    resource_id: str = Field(description="Echo back the resource_id we sent you.")
    monthly_cost_usd: float = Field(ge=0.0)
    unit_cost_usd: float | None = Field(default=None, ge=0.0)
    quantity: int = Field(default=1, ge=1)
    breakdown: str = Field(description="One concise sentence on how the figure was built.")
    confidence: ConfidenceLevel = Field(
        description=(
            "'Medium' when the service is known and you assumed sensible defaults. "
            "'Low' when the cost is dominated by request/data volume the diagram does not specify."
        )
    )
    assumptions: list[str] = Field(default_factory=list)


class _LLMBatchResponse(BaseModel):
    """Wrapper so structured-output works across OpenAI/Anthropic uniformly."""

    items: list[_LLMCostItem] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Deterministic helpers
# ---------------------------------------------------------------------------


def _scaling_baseline(resource: ExtractedResource) -> int:
    """Choose an instance count for a scaling group.

    For an ASG ``min-max`` range we use the **mid-point** of min..max, rounded
    up. This is a defensible "average expected utilization" baseline for the
    estimate, with the range surfaced in ``assumptions`` so the user can see
    both ends of the cost band.
    """
    if resource.max_count and resource.max_count > resource.count:
        return -(-(resource.count + resource.max_count) // 2)  # ceil-div
    return max(resource.count, 1)


def _select_sku(resource: ExtractedResource) -> str | None:
    """Pick the most specific SKU available for this resource."""
    return (
        resource.db_instance_class
        or resource.cache_node_type
        or resource.warehouse_node_type
        or resource.instance_type
    )


def _format_storage_addon(
    resource: ExtractedResource, constants: dict[str, dict[str, float | str]]
) -> tuple[float, str | None]:
    """Compute EBS / Aurora-storage / EFS add-on cost when the resource declares storage."""
    if not resource.storage_gb:
        return 0.0, None

    if resource.canonical_service in {"aurora", "rds"}:
        rate = float(constants.get("aurora-storage-gb-month", {}).get("usd", 0.10))
        return resource.storage_gb * rate, (
            f"+ {resource.storage_gb:.0f} GB Aurora storage @ ${rate:.3f}/GB-mo"
        )
    if resource.canonical_service == "efs":
        rate = float(constants.get("efs-standard-gb-month", {}).get("usd", 0.30))
        return resource.storage_gb * rate, (
            f"+ {resource.storage_gb:.0f} GB EFS standard @ ${rate:.2f}/GB-mo"
        )
    storage_type = resource.storage_type or "gp3"
    key = f"ebs-{storage_type}-gb-month"
    rate = float(constants.get(key, {}).get("usd", 0.08))
    return resource.storage_gb * rate, (
        f"+ {resource.storage_gb:.0f} GB EBS {storage_type} @ ${rate:.2f}/GB-mo"
    )


def _deterministic_estimate(
    resource: ExtractedResource,
    sku_map: dict[str, dict[str, Any]],
    constants: dict[str, dict[str, float | str]],
) -> CostEstimateItem | None:
    """Try to build a CostEstimateItem from the pricing matrix alone.

    Returns ``None`` if the resource has no SKU we can price (caller will
    forward it to the LLM).
    """
    sku = _select_sku(resource)
    if not sku:
        return None
    priced = sku_map.get(sku.lower())
    if not priced or not priced.get("found"):
        return None

    hourly = float(priced["hourly_usd"])
    quantity = _scaling_baseline(resource)
    compute_monthly = hourly * HOURS_PER_MONTH * quantity

    storage_monthly, storage_breakdown = _format_storage_addon(resource, constants)

    breakdown_parts = [
        f"{quantity} x {sku} @ ${hourly:.4f}/hr x 730h = ${compute_monthly:,.2f}/mo"
    ]
    if storage_breakdown:
        breakdown_parts.append(storage_breakdown + f" = ${storage_monthly:,.2f}/mo")

    assumptions: list[str] = []
    if resource.max_count and resource.max_count > resource.count:
        assumptions.append(
            f"Scaling group {resource.count}-{resource.max_count}; using mid-point {quantity}."
        )
    if resource.multi_az:
        assumptions.append("Multi-AZ flag set; price reflects per-AZ instance only.")
    if not resource.storage_gb and resource.canonical_service in {"aurora", "rds"}:
        assumptions.append("Aurora storage GB not declared; storage cost not included.")

    return CostEstimateItem(
        resource_id=resource.id,
        title=resource.title,
        service=resource.canonical_service,
        account=resource.account,
        region=resource.region,
        instance_type=sku,
        quantity=quantity,
        monthly_cost_usd=round(compute_monthly + storage_monthly, 2),
        unit_cost_usd=round(hourly * HOURS_PER_MONTH, 2),
        breakdown=" ".join(breakdown_parts),
        confidence="High (Infracost)",
        assumptions=assumptions,
    )


# ---------------------------------------------------------------------------
# LLM batch path
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """You are a senior AWS FinOps engineer producing **us-east-1 on-demand** monthly cost estimates.

For each resource you receive:
- Reason about the AWS pricing model that applies to its service.
- Use the per-unit constants table you are given as the source of truth where available
  (e.g. S3 standard at $0.023/GB-month, NAT Gateway at $0.045/hour per gateway, KMS CMKs
  at $1/month per key, Secrets Manager at $0.40/secret/month).
- If the diagram does not specify usage volume (data ingest, requests, scanned bytes, ...),
  pick a *modest production-default* and call it out in `assumptions`.
- Multi-AZ NAT Gateways multiply per-AZ.
- Be deliberately conservative; do not invent traffic numbers that are not implied.
- Always echo back the same `resource_id` you receive.
- Use confidence ``Medium`` when the service is known and you used a reasonable default;
  ``Low`` only when the figure is dominated by workload volume the diagram does not pin down.
"""


def _serialize_resource_for_llm(r: ExtractedResource) -> dict[str, Any]:
    """Slim, deterministic JSON shape we hand to the LLM."""
    return {
        "resource_id": r.id,
        "title": r.title,
        "service": r.canonical_service,
        "account": r.account,
        "region": r.region,
        "availability_zone": r.availability_zone,
        "instance_type": r.instance_type,
        "db_instance_class": r.db_instance_class,
        "cache_node_type": r.cache_node_type,
        "warehouse_node_type": r.warehouse_node_type,
        "storage_gb": r.storage_gb,
        "storage_type": r.storage_type,
        "count": r.count,
        "max_count": r.max_count,
        "multi_az": r.multi_az,
        "engine": r.engine,
        "role": r.role,
        "raw_config": r.raw_config,
        "reason": r.reason,
    }


async def _llm_estimate_batch(
    resources: list[ExtractedResource],
    constants: dict[str, dict[str, float | str]],
) -> list[_LLMCostItem]:
    """Single batched LLM call producing one item per input resource."""
    if not resources:
        return []

    llm = get_llm().with_structured_output(_LLMBatchResponse)
    prompt = ChatPromptTemplate.from_messages(
        [
            SystemMessage(content=_SYSTEM_PROMPT),
            HumanMessage(
                content=(
                    "Pricing constants (USD):\n"
                    f"{constants}\n\n"
                    "Resources to estimate (one CostEstimateItem per resource_id):\n"
                    f"{[_serialize_resource_for_llm(r) for r in resources]}\n\n"
                    "Return strictly the structured-output schema."
                )
            ),
        ]
    )
    chain = prompt | llm
    try:
        response: _LLMBatchResponse = await chain.ainvoke({})
    except Exception:
        logger.exception("estimator: LLM batch call failed; falling back to zeros")
        return [
            _LLMCostItem(
                resource_id=r.id,
                monthly_cost_usd=0.0,
                quantity=1,
                breakdown="LLM call failed; defaulted to $0/month.",
                confidence="Low",
                assumptions=["LLM estimation unavailable."],
            )
            for r in resources
        ]
    return list(response.items)


def _merge_llm_into_estimate(
    resource: ExtractedResource, llm_item: _LLMCostItem
) -> CostEstimateItem:
    return CostEstimateItem(
        resource_id=resource.id,
        title=resource.title,
        service=resource.canonical_service,
        account=resource.account,
        region=resource.region,
        instance_type=_select_sku(resource),
        quantity=llm_item.quantity,
        monthly_cost_usd=round(llm_item.monthly_cost_usd, 2),
        unit_cost_usd=round(llm_item.unit_cost_usd, 4) if llm_item.unit_cost_usd else None,
        breakdown=llm_item.breakdown,
        confidence=llm_item.confidence,
        assumptions=list(llm_item.assumptions),
    )


# ---------------------------------------------------------------------------
# Public node entrypoint
# ---------------------------------------------------------------------------


_ZERO_COST_SERVICES: set[str] = {
    # Identity / governance / control plane -- free at this granularity.
    "iam",
    "iam-identity-center",
    "organizations",
    "control-tower",
    "acm",
    "budgets",
    "compute-optimizer",
    "external-user",
    "external-git",
}


def _zero_cost_placeholder(resource: ExtractedResource) -> CostEstimateItem:
    return CostEstimateItem(
        resource_id=resource.id,
        title=resource.title,
        service=resource.canonical_service,
        account=resource.account,
        region=resource.region,
        monthly_cost_usd=0.0,
        breakdown="No direct charge for this service at typical usage.",
        confidence="Medium",
        assumptions=["AWS does not bill this service directly under standard usage."],
    )


async def llm_cost_aggregator(state: OverallState) -> dict[str, Any]:
    resources: list[ExtractedResource] = list(state.get("parsed_resources") or [])
    pricing: dict[str, Any] = state.get("infracost_results") or {}
    sku_map: dict[str, dict[str, Any]] = pricing.get("_skus") or {}
    constants: dict[str, dict[str, float | str]] = pricing.get("_constants") or {}

    if not resources:
        logger.info("estimator: no resources to estimate")
        return {"final_costs": [], "total_monthly_cost": 0.0}

    deterministic: list[CostEstimateItem] = []
    llm_targets: list[ExtractedResource] = []

    for resource in resources:
        if resource.canonical_service in _ZERO_COST_SERVICES:
            deterministic.append(_zero_cost_placeholder(resource))
            continue
        det = _deterministic_estimate(resource, sku_map, constants)
        if det is not None:
            deterministic.append(det)
        else:
            llm_targets.append(resource)

    llm_items = await _llm_estimate_batch(llm_targets, constants)
    llm_items_by_id: dict[str, _LLMCostItem] = {item.resource_id: item for item in llm_items}

    llm_estimates: list[CostEstimateItem] = []
    for resource in llm_targets:
        item = llm_items_by_id.get(resource.id)
        if item is None:
            llm_estimates.append(
                CostEstimateItem(
                    resource_id=resource.id,
                    title=resource.title,
                    service=resource.canonical_service,
                    account=resource.account,
                    region=resource.region,
                    monthly_cost_usd=0.0,
                    breakdown="LLM did not return an item for this resource; defaulted to $0.",
                    confidence="Low",
                    assumptions=["LLM omitted this resource."],
                )
            )
        else:
            llm_estimates.append(_merge_llm_into_estimate(resource, item))

    final_costs = deterministic + llm_estimates
    total = round(sum(item.monthly_cost_usd for item in final_costs), 2)
    logger.info(
        "estimator: %d items (deterministic=%d, llm=%d); total=$%.2f/mo",
        len(final_costs),
        len(deterministic),
        len(llm_estimates),
        total,
    )
    return {"final_costs": final_costs, "total_monthly_cost": total}


__all__ = ["llm_cost_aggregator", "EnvironmentTier"]
