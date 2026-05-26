"""LangGraph node #1: ``parse_and_contextualize``.

Filters the raw diagram down to billable leaf nodes, extracts technical
configuration from the structured ``description`` field, and contextualizes
each resource by walking its ``parentId`` chain to determine the account
(Production / Management / Deployment / Dev/QA / Global / Unknown), region,
and availability zone.

This node is intentionally deterministic (regex-based). For a description
format that drifts toward free-form prose, swap the ``_extract_*`` helpers
for ``llm.with_structured_output(ExtractedResource)`` -- the public node
signature does not change. (Open/Closed Principle.)
"""
from __future__ import annotations

import logging
import re
from typing import Any

from ..state import EnvironmentTier, ExtractedResource, OverallState
from ..utils import extract_az, extract_region, is_group_node

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Service-type detection
# ---------------------------------------------------------------------------

_NODE_TYPE_TO_SERVICE: dict[str, str] = {
    "aws-elasticbeanstalk": "beanstalk",
    "aws-amazonaurora": "aurora",
    "aws-amazonelasticache": "elasticache",
    "aws-amazonredshift": "redshift",
    "aws-amazons3": "s3",
    "aws-amazonefs": "efs",
    "aws-elasticloadbalancing": "elb",
    "aws-amazondatafirehose": "firehose",
    "aws-amazoncloudwatch": "cloudwatch",
    "aws-amazonsimplenotificationservice": "sns",
    "aws-transitgateway": "transit-gateway",
    "aws-keymanagementservice": "kms",
    "aws-secretsmanager": "secrets-manager",
    "aws-databasemigrationservice": "dms",
    "aws-cloudtrail": "cloudtrail",
    "aws-amazonguardduty": "guardduty",
    "aws-securityhub": "security-hub",
    "aws-amazoninspector": "inspector",
    "aws-auditmanager": "audit-manager",
    "aws-backup": "backup",
    "aws-waf": "waf",
    "aws-shield": "shield",
    "aws-certificatemanager": "acm",
    "aws-amazonroute53": "route53",
    "aws-amazoncloudfront": "cloudfront",
    "aws-identityandaccessmanagement": "iam",
    "aws-organizations": "organizations",
    "aws-controltower": "control-tower",
    "aws-amazonec2": "ec2",
    "aws-glue": "glue",
    "aws-amazonquicksight": "quicksight",
    "aws-amazonathena": "athena",
    "aws-xray": "x-ray",
    "aws-stepfunctions": "step-functions",
    "aws-privatelink": "privatelink",
    "aws-iamidentitycenter": "iam-identity-center",
    "aws-budgets": "budgets",
    "aws-computeoptimizer": "compute-optimizer",
}

# Title-keyword fallback for nodes whose ``type`` is ``"default"`` or ambiguous.
_TITLE_KEYWORD_TO_SERVICE: tuple[tuple[str, str], ...] = (
    ("aurora", "aurora"),
    ("elasticache", "elasticache"),
    ("redshift", "redshift"),
    ("cloudfront", "cloudfront"),
    ("route 53", "route53"),
    ("route53", "route53"),
    ("cloudwatch", "cloudwatch"),
    ("cloudtrail", "cloudtrail"),
    ("waf", "waf"),
    ("shield", "shield"),
    ("kms", "kms"),
    ("secrets manager", "secrets-manager"),
    ("guardduty", "guardduty"),
    ("inspector", "inspector"),
    ("security hub", "security-hub"),
    ("transit gateway", "transit-gateway"),
    ("nat gateway", "nat-gateway"),
    ("internet gateway", "internet-gateway"),
    ("bastion", "ec2-bastion"),
    ("jenkins", "ec2-jenkins"),
    ("sophos", "ec2-sophos-utm"),
    ("datadog", "datadog-saas"),
    ("git", "external-git"),
    ("beanstalk", "beanstalk"),
    ("redshift", "redshift"),
    ("efs", "efs"),
    ("athena", "athena"),
    ("quicksight", "quicksight"),
    ("glue", "glue"),
    ("firehose", "firehose"),
    ("sns", "sns"),
    ("dms", "dms"),
    ("backup", "backup"),
    ("certificate manager", "acm"),
    ("iam", "iam"),
    ("organizations", "organizations"),
    ("control tower", "control-tower"),
    ("x-ray", "x-ray"),
)


def _detect_service(node_type: str, title: str) -> str:
    """Resolve a canonical service name from ``type`` (authoritative) and ``title``."""
    canonical = _NODE_TYPE_TO_SERVICE.get(node_type.lower())
    if canonical:
        return canonical
    title_lower = title.lower()
    for keyword, service in _TITLE_KEYWORD_TO_SERVICE:
        if keyword in title_lower:
            return service
    if node_type.lower() == "user":
        return "external-user"
    return node_type.lower() or "unknown"


# ---------------------------------------------------------------------------
# Description-field parsing
# ---------------------------------------------------------------------------

# Capture each labeled line (Role / Config / Reason / Addresses).
_DESC_FIELD_RE = re.compile(
    r"^(?P<key>Role|Config|Reason|Addresses)\s*:\s*(?P<value>.*?)\s*$",
    re.MULTILINE | re.IGNORECASE,
)

# Patterns mined from the Config: block.
_INSTANCE_TYPE_RE = re.compile(
    r"(?:Instance\s*Type|Class|Node\s*Type|Worker\s*Type|Replication\s*Instance)\s*=\s*"
    r"(?P<v>[A-Za-z0-9_.\-]+(?:\.[A-Za-z0-9]+)*)",
    re.IGNORECASE,
)
# Free-text fallback: matches AWS-style instance types anywhere in the blob
# (e.g. "Self-hosted on EC2 m5.large" -- no "Instance Type=" anchor).
_FREE_TEXT_INSTANCE_RE = re.compile(
    r"\b((?:dms\.)?[a-z]{1,3}[0-9]{1,2}[a-z]{0,3}\."
    r"(?:nano|micro|small|medium|large|\d{0,2}xlarge|metal))\b",
    re.IGNORECASE,
)
_DB_CLASS_RE = re.compile(r"\bdb\.[a-z0-9]+\.[a-z0-9]+\b", re.IGNORECASE)
_CACHE_NODE_RE = re.compile(r"\bcache\.[a-z0-9]+\.[a-z0-9]+\b", re.IGNORECASE)
_REDSHIFT_NODE_RE = re.compile(
    r"\b(ra3\.[0-9]+x?large|dc2\.[a-z0-9]+|ds2\.[a-z0-9]+)\b", re.IGNORECASE
)
_STORAGE_RE = re.compile(
    r"(?:EBS\s*Volume|Allocated\s*Storage|Storage|Disk)\s*=?\s*"
    r"(?P<v>\d+(?:\.\d+)?)\s*(?P<unit>GB|TB|GiB|TiB)",
    re.IGNORECASE,
)
_STORAGE_TYPE_RE = re.compile(r"\b(gp2|gp3|io1|io2|st1|sc1|magnetic)\b", re.IGNORECASE)
_SCALING_RE = re.compile(
    r"(?:Scaling|ASG(?:\s*(?:Size|min/max))?|Auto\s*Scaling)\s*=?\s*"
    r"(?P<lo>\d+)\s*[-to]+\s*(?P<hi>\d+)",
    re.IGNORECASE,
)
_FIXED_COUNT_RE = re.compile(
    r"(?:Clusters|Nodes|Replicas|Instances|ASG\s*Size)\s*=\s*(?P<n>\d+)",
    re.IGNORECASE,
)
_WRITER_READER_RE = re.compile(
    r"(?P<w>\d+)\s*writer[s]?\s*\+\s*(?P<r>\d+)\s*reader[s]?", re.IGNORECASE
)
_MULTI_AZ_RE = re.compile(r"Multi[-_ ]?AZ\s*=\s*(true|enabled|yes)", re.IGNORECASE)
_ENGINE_RE = re.compile(r"Engine\s*=\s*(?P<v>[A-Za-z0-9_\-./]+)", re.IGNORECASE)
_REDSHIFT_NODE_COUNT_RE = re.compile(
    r"Node\s*Type\s*=\s*[A-Za-z0-9.]+\s*\((?P<n>\d+)\s*nodes?\)", re.IGNORECASE
)


def _parse_description(description: str | None) -> dict[str, Any]:
    """Lift the four labeled lines (Role/Config/Reason/Addresses) into a dict."""
    out: dict[str, Any] = {
        "role": None,
        "raw_config": None,
        "reason": None,
        "addresses": [],
    }
    if not description:
        return out
    for match in _DESC_FIELD_RE.finditer(description):
        key = match.group("key").lower()
        value = match.group("value").strip()
        if key == "role":
            out["role"] = value
        elif key == "config":
            out["raw_config"] = value
        elif key == "reason":
            out["reason"] = value
        elif key == "addresses":
            tokens = [t.strip() for t in re.split(r"[,;]", value) if t.strip()]
            out["addresses"] = [t for t in tokens if t.upper() != "N/A"]
    return out


def _extract_technical_fields(config_blob: str | None) -> dict[str, Any]:
    """Mine instance/storage/count/engine details out of the Config blob.

    All fields are optional; missing fields stay ``None``. We deliberately do
    multiple targeted passes (one regex per field) instead of a single mega
    regex -- this scales O(L * K) for L = config length, K = number of fields,
    but K is a small constant so it is effectively linear in L.
    """
    out: dict[str, Any] = {
        "instance_type": None,
        "db_instance_class": None,
        "cache_node_type": None,
        "warehouse_node_type": None,
        "storage_gb": None,
        "storage_type": None,
        "count": None,
        "max_count": None,
        "multi_az": None,
        "engine": None,
    }
    if not config_blob:
        return out

    db_match = _DB_CLASS_RE.search(config_blob)
    if db_match:
        out["db_instance_class"] = db_match.group(0).lower()

    cache_match = _CACHE_NODE_RE.search(config_blob)
    if cache_match:
        out["cache_node_type"] = cache_match.group(0).lower()

    rs_match = _REDSHIFT_NODE_RE.search(config_blob)
    if rs_match:
        out["warehouse_node_type"] = rs_match.group(0).lower()

    inst_match = _INSTANCE_TYPE_RE.search(config_blob)
    if inst_match:
        candidate = inst_match.group("v")
        # Avoid double-counting DB/cache classes captured above.
        if not (
            candidate.lower().startswith("db.")
            or candidate.lower().startswith("cache.")
        ) and "." in candidate:
            out["instance_type"] = candidate

    # Free-text fallback if the labeled-form did not yield an instance.
    if not out["instance_type"]:
        ft_match = _FREE_TEXT_INSTANCE_RE.search(config_blob)
        if ft_match:
            candidate = ft_match.group(1).lower()
            if not (candidate.startswith("db.") or candidate.startswith("cache.")):
                out["instance_type"] = candidate

    storage_match = _STORAGE_RE.search(config_blob)
    if storage_match:
        value = float(storage_match.group("v"))
        unit = storage_match.group("unit").upper()
        if unit in ("TB", "TIB"):
            value *= 1024
        out["storage_gb"] = value

    storage_type_match = _STORAGE_TYPE_RE.search(config_blob)
    if storage_type_match:
        out["storage_type"] = storage_type_match.group(1).lower()

    scaling_match = _SCALING_RE.search(config_blob)
    if scaling_match:
        out["count"] = int(scaling_match.group("lo"))
        out["max_count"] = int(scaling_match.group("hi"))
    else:
        wr_match = _WRITER_READER_RE.search(config_blob)
        if wr_match:
            out["count"] = int(wr_match.group("w")) + int(wr_match.group("r"))
        else:
            redshift_count = _REDSHIFT_NODE_COUNT_RE.search(config_blob)
            if redshift_count:
                out["count"] = int(redshift_count.group("n"))
            else:
                fixed_match = _FIXED_COUNT_RE.search(config_blob)
                if fixed_match:
                    out["count"] = int(fixed_match.group("n"))

    if _MULTI_AZ_RE.search(config_blob):
        out["multi_az"] = True

    engine_match = _ENGINE_RE.search(config_blob)
    if engine_match:
        out["engine"] = engine_match.group("v").lower()

    return out


# ---------------------------------------------------------------------------
# Hierarchy / context resolution
# ---------------------------------------------------------------------------

_ACCOUNT_KEYWORDS: tuple[tuple[str, EnvironmentTier], ...] = (
    ("production", "Production"),
    ("prod ", "Production"),
    ("prod-", "Production"),
    ("management", "Management"),
    ("mgmt", "Management"),
    ("deployment", "Deployment"),
    ("dev", "Dev/QA"),
    ("qa", "Dev/QA"),
    ("staging", "Dev/QA"),
)


def _build_parent_chain(
    node_id: str,
    nodes_by_id: dict[str, dict[str, Any]],
    memo: dict[str, list[str]],
) -> list[str]:
    """Return the list of ancestor node IDs for ``node_id``, leaf-first.

    Memoized so that repeated lookups along the same spine are O(1) after the
    first walk -- amortized total work across all nodes is O(N) rather than
    O(N * D).
    """
    if node_id in memo:
        return memo[node_id]
    chain: list[str] = []
    current = nodes_by_id.get(node_id, {}).get("parentId")
    visited: set[str] = {node_id}
    while current and current not in visited:
        chain.append(current)
        visited.add(current)
        current = nodes_by_id.get(current, {}).get("parentId")
    memo[node_id] = chain
    return chain


def _resolve_environment(
    parent_chain: list[str], nodes_by_id: dict[str, dict[str, Any]]
) -> EnvironmentTier:
    """Walk leaf->root looking for an account-flavored zone."""
    for ancestor_id in parent_chain:
        title = (nodes_by_id.get(ancestor_id, {}).get("title") or "").lower()
        for keyword, tier in _ACCOUNT_KEYWORDS:
            if keyword in title:
                return tier
    # Global services (Route53, CloudFront, WAF, Shield, IAM, etc.) sit directly
    # under aws-cloud -- no account ancestor.
    if any(
        (nodes_by_id.get(aid, {}).get("type") or "").startswith("aws-group-awscloud")
        for aid in parent_chain
    ):
        return "Global"
    return "Unknown"


def _resolve_region(
    parent_chain: list[str], nodes_by_id: dict[str, dict[str, Any]]
) -> str | None:
    for ancestor_id in parent_chain:
        ancestor = nodes_by_id.get(ancestor_id, {})
        region = extract_region(ancestor.get("id"))
        if region:
            return region
        region = extract_region(ancestor.get("title"))
        if region:
            return region
    return None


# ---------------------------------------------------------------------------
# Edge adjacency
# ---------------------------------------------------------------------------


def _build_adjacency(
    edges: list[dict[str, Any]],
) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    """Return (outgoing, incoming) adjacency maps.

    Time: O(E). Space: O(E).
    """
    outgoing: dict[str, list[str]] = {}
    incoming: dict[str, list[str]] = {}
    for edge in edges:
        src = edge.get("source")
        tgt = edge.get("target")
        if not (isinstance(src, str) and isinstance(tgt, str)):
            continue
        outgoing.setdefault(src, []).append(tgt)
        incoming.setdefault(tgt, []).append(src)
    return outgoing, incoming


# ---------------------------------------------------------------------------
# Public node entrypoint
# ---------------------------------------------------------------------------


async def parse_and_contextualize(state: OverallState) -> dict[str, Any]:
    """LangGraph node: produce ``ExtractedResource`` list from ``raw_diagram``.

    Pipeline:
        1. Index nodes by ID.
        2. Build edge adjacency maps (O(E)).
        3. For every non-group node:
            a. Resolve parent chain (memoized BFS upward).
            b. Resolve account tier / region / AZ.
            c. Parse description -> role/config/reason/addresses.
            d. Extract technical fields from the Config blob.
            e. Detect canonical service.
            f. Attach edge neighbors.
        4. Return ``{"parsed_resources": [...]}`` for LangGraph to merge.

    Total complexity: O(N + E + N * L) where L is average description length.
    Memory: O(N + E).
    """
    diagram = state.get("raw_diagram") or {}
    raw_nodes: list[dict[str, Any]] = list(diagram.get("nodes") or [])
    raw_edges: list[dict[str, Any]] = list(diagram.get("edges") or [])

    if not raw_nodes:
        logger.warning("parser: diagram has no nodes")
        return {"parsed_resources": [], "errors": ["diagram contained no nodes"]}

    nodes_by_id: dict[str, dict[str, Any]] = {
        n["id"]: n for n in raw_nodes if isinstance(n, dict) and "id" in n
    }
    outgoing, incoming = _build_adjacency(raw_edges)
    parent_chain_memo: dict[str, list[str]] = {}

    resources: list[ExtractedResource] = []
    errors: list[str] = []

    for node in raw_nodes:
        try:
            if not isinstance(node, dict):
                continue
            if is_group_node(node):
                continue

            node_id = node.get("id")
            if not isinstance(node_id, str):
                continue

            title = node.get("title") or node_id
            node_type = (node.get("type") or "").strip() or "unknown"

            parent_chain = _build_parent_chain(node_id, nodes_by_id, parent_chain_memo)
            account = _resolve_environment(parent_chain, nodes_by_id)
            region = _resolve_region(parent_chain, nodes_by_id) or extract_region(node_id)
            az = extract_az(node_id) or extract_az(title)

            desc_parts = _parse_description(node.get("description"))
            tech = _extract_technical_fields(desc_parts["raw_config"])

            resource = ExtractedResource(
                id=node_id,
                title=title,
                node_type=node_type,
                canonical_service=_detect_service(node_type, title),
                role=desc_parts["role"],
                raw_config=desc_parts["raw_config"],
                reason=desc_parts["reason"],
                addresses=desc_parts["addresses"],
                instance_type=tech["instance_type"],
                db_instance_class=tech["db_instance_class"],
                cache_node_type=tech["cache_node_type"],
                warehouse_node_type=tech["warehouse_node_type"],
                storage_gb=tech["storage_gb"],
                storage_type=tech["storage_type"],
                count=tech["count"] or 1,
                max_count=tech["max_count"],
                multi_az=tech["multi_az"],
                engine=tech["engine"],
                account=account,
                region=region,
                availability_zone=az,
                parent_chain=parent_chain,
                connected_to=outgoing.get(node_id, []),
                connected_from=incoming.get(node_id, []),
            )
            resources.append(resource)
        except Exception as exc:  # noqa: BLE001 -- robust outer loop
            logger.exception("parser: failed to parse node %s", node.get("id"))
            errors.append(f"parse failed for {node.get('id')!r}: {exc}")

    logger.info(
        "parser: extracted %d resources from %d raw nodes (%d edges)",
        len(resources),
        len(raw_nodes),
        len(raw_edges),
    )
    out: dict[str, Any] = {"parsed_resources": resources}
    if errors:
        out["errors"] = errors
    return out
