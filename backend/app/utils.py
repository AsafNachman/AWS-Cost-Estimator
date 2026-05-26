"""Reusable helpers shared across pipeline nodes.

Kept small and dependency-free so each node can import what it needs without
incurring extra startup cost.
"""
from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger("aws-cost-estimator")

GROUP_NODE_PREFIXES: tuple[str, ...] = (
    "aws-group-",
    "genericzone",
)
"""Node-type prefixes that mark a layout/grouping container with no direct cost."""


def is_group_node(node: dict[str, Any]) -> bool:
    """Return True if a node is a layout container (zone / VPC / subnet / region).

    Time complexity: O(P) where P is the number of group prefixes (constant).
    """
    raw_type = (node.get("type") or "").lower()
    return any(raw_type.startswith(p) for p in GROUP_NODE_PREFIXES)


_REGION_RE = re.compile(r"\b([a-z]{2}-[a-z]+-\d)\b")
_AZ_RE = re.compile(r"\b([a-z]{2}-[a-z]+-\d[a-c])\b|\baz-([a-c])\b", re.IGNORECASE)


def extract_region(text: str | None) -> str | None:
    """Pull an AWS region (e.g. ``us-east-1``) out of free text. Greedy first match."""
    if not text:
        return None
    match = _REGION_RE.search(text)
    return match.group(1) if match else None


def extract_az(text: str | None) -> str | None:
    """Pull an availability-zone-ish suffix (e.g. ``us-east-1a`` or ``AZ-A``)."""
    if not text:
        return None
    match = _AZ_RE.search(text)
    if not match:
        return None
    # group(1) catches full AZ (us-east-1a); group(2) catches the short "AZ-A" form.
    return (match.group(1) or f"AZ-{match.group(2).upper()}").lower().replace("az-", "AZ-")
