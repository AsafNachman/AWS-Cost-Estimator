"""LangGraph node #2: ``infracost_lookup``.

Enriches each parsed resource with baseline unit-pricing data, simulating an
Infracost CLI / Cloud Pricing API call. The output is keyed by SKU so the
downstream estimator can join on it.

Production swap-out
-------------------
Replace ``_simulated_infracost_call`` with one of:

* ``asyncio.create_subprocess_exec("infracost", "breakdown", "--path", ...)``
  parsing the JSON output, OR
* an ``httpx.AsyncClient`` POST to ``https://pricing.api.infracost.io/graphql``
  with the appropriate query.

The node's public signature does not change. (Strategy Pattern: the lookup
function is the interchangeable strategy; ``infracost_lookup`` is the policy.)
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from ..state import ExtractedResource, OverallState

logger = logging.getLogger(__name__)

HOURS_PER_MONTH = 730.0
"""AWS billing convention: 730 hours per month (24 * 365.25 / 12)."""

# ---------------------------------------------------------------------------
# Pricing matrix: us-east-1, on-demand Linux, approximate (May 2024).
# Hourly USD per unit. monthly = hourly * HOURS_PER_MONTH.
# ---------------------------------------------------------------------------

_EC2_HOURLY: dict[str, float] = {
    # General-purpose Graviton -- core app tier
    "m6g.large": 0.077,
    "m6g.xlarge": 0.154,
    "m6g.2xlarge": 0.308,
    "m6g.4xlarge": 0.616,
    # General-purpose x86
    "m5.large": 0.096,
    "m5.xlarge": 0.192,
    "m5.2xlarge": 0.384,
    # Burstable
    "t3.nano": 0.0052,
    "t3.micro": 0.0104,
    "t3.small": 0.0208,
    "t3.medium": 0.0416,
    "t3.large": 0.0832,
    # Compute-optimized
    "c5.large": 0.085,
    "c5.xlarge": 0.17,
    # DMS uses the same family as c5 prices (with a small premium); treat as ec2-like.
    "dms.c5.large": 0.154,
    "dms.c5.xlarge": 0.308,
}

_RDS_AURORA_HOURLY: dict[str, float] = {
    # Aurora MySQL/PostgreSQL provisioned (per-instance, db.r5 family).
    "db.t3.medium": 0.082,
    "db.t3.large": 0.164,
    "db.r5.large": 0.29,
    "db.r5.xlarge": 0.58,
    "db.r5.2xlarge": 1.04,
    "db.r5.4xlarge": 2.08,
    "db.r6g.large": 0.26,
    "db.r6g.xlarge": 0.52,
    "db.r6g.2xlarge": 1.04,
}

_ELASTICACHE_HOURLY: dict[str, float] = {
    "cache.t3.micro": 0.017,
    "cache.t3.small": 0.034,
    "cache.t3.medium": 0.068,
    "cache.r6g.large": 0.226,
    "cache.r6g.xlarge": 0.452,
    "cache.r6g.2xlarge": 0.904,
}

_REDSHIFT_HOURLY: dict[str, float] = {
    "dc2.large": 0.25,
    "dc2.8xlarge": 4.80,
    "ra3.xlplus": 1.086,
    "ra3.4xlarge": 3.26,
    "ra3.16xlarge": 13.04,
}

# ---------------------------------------------------------------------------
# Per-service flat / per-GB constants (used by the estimator for context).
# ---------------------------------------------------------------------------

_SERVICE_CONSTANTS: dict[str, dict[str, float | str]] = {
    "s3-standard-gb-month": {"usd": 0.023, "unit": "GB-month"},
    "efs-standard-gb-month": {"usd": 0.30, "unit": "GB-month"},
    "ebs-gp3-gb-month": {"usd": 0.08, "unit": "GB-month"},
    "ebs-gp2-gb-month": {"usd": 0.10, "unit": "GB-month"},
    "aurora-storage-gb-month": {"usd": 0.10, "unit": "GB-month"},
    "redshift-managed-storage-gb-month": {"usd": 0.024, "unit": "GB-month"},
    "nat-gateway-hourly": {"usd": 0.045, "unit": "hour"},
    "alb-hourly": {"usd": 0.0225, "unit": "hour"},
    "kms-cmk-monthly": {"usd": 1.00, "unit": "key-month"},
    "secrets-manager-monthly": {"usd": 0.40, "unit": "secret-month"},
    "cloudwatch-custom-metric-monthly": {"usd": 0.30, "unit": "metric-month"},
    "waf-webacl-monthly": {"usd": 5.00, "unit": "webacl-month"},
    "waf-rule-monthly": {"usd": 1.00, "unit": "rule-month"},
    "shield-advanced-monthly": {"usd": 3000.00, "unit": "subscription-month"},
    "cloudfront-gb-out": {"usd": 0.085, "unit": "GB"},
    "route53-hosted-zone-monthly": {"usd": 0.50, "unit": "zone-month"},
    "transit-gateway-attachment-hourly": {"usd": 0.05, "unit": "attachment-hour"},
    "transit-gateway-gb-processed": {"usd": 0.02, "unit": "GB"},
    "firehose-gb-ingested": {"usd": 0.029, "unit": "GB"},
    "glue-dpu-hour": {"usd": 0.44, "unit": "DPU-hour"},
    "athena-tb-scanned": {"usd": 5.00, "unit": "TB-scanned"},
    "quicksight-author-monthly": {"usd": 24.00, "unit": "user-month"},
    "quicksight-reader-monthly": {"usd": 0.30, "unit": "session-30min"},
}


# ---------------------------------------------------------------------------
# Lookup primitives
# ---------------------------------------------------------------------------


def _lookup_hourly(sku: str) -> float | None:
    """Resolve an hourly USD rate for a given SKU. ``None`` if unknown."""
    sku_lower = sku.lower()
    if sku_lower in _EC2_HOURLY:
        return _EC2_HOURLY[sku_lower]
    if sku_lower in _RDS_AURORA_HOURLY:
        return _RDS_AURORA_HOURLY[sku_lower]
    if sku_lower in _ELASTICACHE_HOURLY:
        return _ELASTICACHE_HOURLY[sku_lower]
    if sku_lower in _REDSHIFT_HOURLY:
        return _REDSHIFT_HOURLY[sku_lower]
    return None


def _classify_sku(sku: str) -> str:
    """Return the AWS family ('ec2' / 'rds' / 'elasticache' / 'redshift')."""
    sku_lower = sku.lower()
    if sku_lower.startswith("db."):
        return "rds-aurora"
    if sku_lower.startswith("cache."):
        return "elasticache"
    if sku_lower.startswith(("ra3.", "dc2.", "ds2.")):
        return "redshift"
    return "ec2"


async def _simulated_infracost_call(sku: str) -> dict[str, Any]:
    """Pretend to call ``infracost breakdown`` for a single SKU.

    Awaits 0 ms but is genuinely async-coloured so we can ``asyncio.gather``
    many of these. Returns the same shape the real Infracost JSON output
    exposes (price per hour + monthly).
    """
    await asyncio.sleep(0)
    hourly = _lookup_hourly(sku)
    if hourly is None:
        return {
            "sku": sku,
            "found": False,
            "family": _classify_sku(sku),
            "hourly_usd": None,
            "monthly_usd": None,
            "source": "infracost-simulated",
            "region": "us-east-1",
        }
    return {
        "sku": sku,
        "found": True,
        "family": _classify_sku(sku),
        "hourly_usd": round(hourly, 6),
        "monthly_usd": round(hourly * HOURS_PER_MONTH, 2),
        "source": "infracost-simulated",
        "region": "us-east-1",
    }


def _collect_skus(resources: list[ExtractedResource]) -> list[str]:
    """De-duplicate every SKU we should price across the resource list."""
    seen: set[str] = set()
    for r in resources:
        for candidate in (
            r.instance_type,
            r.db_instance_class,
            r.cache_node_type,
            r.warehouse_node_type,
        ):
            if candidate:
                seen.add(candidate.lower())
    return sorted(seen)


# ---------------------------------------------------------------------------
# Public node entrypoint
# ---------------------------------------------------------------------------


async def infracost_lookup(state: OverallState) -> dict[str, Any]:
    """LangGraph node: produce ``infracost_results`` keyed by SKU.

    Algorithm:
        1. Gather every distinct SKU appearing in the parsed resources.
        2. Fan out one async lookup per SKU via ``asyncio.gather`` --
           wall-clock latency is bounded by the single slowest call, not
           the sum (this is what makes the swap to a real network call
           worthwhile).
        3. Attach the ``_SERVICE_CONSTANTS`` table so the estimator has
           per-GB / per-hour rates for usage-driven services too.

    Time: O(K) lookups in parallel for K = unique SKUs.
    Space: O(K + C) for K SKUs and C service constants.
    """
    resources: list[ExtractedResource] = list(state.get("parsed_resources") or [])
    skus = _collect_skus(resources)

    if not skus:
        logger.info("enricher: no SKUs to price; skipping fan-out")
        return {
            "infracost_results": {
                "_skus": {},
                "_constants": _SERVICE_CONSTANTS,
                "_meta": {
                    "source": "infracost-simulated",
                    "region": "us-east-1",
                    "hours_per_month": HOURS_PER_MONTH,
                    "skus_queried": 0,
                    "skus_found": 0,
                },
            }
        }

    results = await asyncio.gather(*(_simulated_infracost_call(sku) for sku in skus))
    sku_map: dict[str, dict[str, Any]] = {r["sku"]: r for r in results}
    found = sum(1 for r in results if r["found"])
    logger.info("enricher: priced %d / %d SKUs", found, len(skus))

    return {
        "infracost_results": {
            "_skus": sku_map,
            "_constants": _SERVICE_CONSTANTS,
            "_meta": {
                "source": "infracost-simulated",
                "region": "us-east-1",
                "hours_per_month": HOURS_PER_MONTH,
                "skus_queried": len(skus),
                "skus_found": found,
            },
        }
    }
