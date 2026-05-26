"""Shared graph state and domain models for the cost-estimator pipeline.

The pipeline is a four-stage LangGraph (parse -> enrich -> estimate -> explain).
Each stage reads from and writes to the same ``OverallState`` mapping. LangGraph
requires a ``TypedDict`` for the state schema (it relies on key-level merging),
so the container is a ``TypedDict`` while the *items* inside list-valued keys
are full Pydantic v2 models for strict validation and serialization.
"""
from __future__ import annotations

import operator
from typing import Annotated, Any, Literal, TypedDict

from pydantic import BaseModel, ConfigDict, Field

ConfidenceLevel = Literal["High (Infracost)", "Medium", "Low"]
"""Confidence tier for a single cost estimate.

* ``High (Infracost)`` -- the instance type was matched against the pricing
  matrix; the unit price is grounded in real data.
* ``Medium`` -- the service is known but we had to assume defaults (e.g. an
  Aurora cluster with no specified instance class).
* ``Low`` -- usage-driven or serverless service whose actual bill is heavily
  workload-dependent (S3, Athena, Glue, Firehose, Lambda...).
"""

EnvironmentTier = Literal[
    "Production",
    "Management",
    "Deployment",
    "Dev/QA",
    "Global",
    "Unknown",
]
"""Account / environment tier derived from the ``parentId`` chain."""


class ExtractedResource(BaseModel):
    """Normalized representation of a single AWS resource node.

    The parser converts each leaf node of the diagram (i.e. anything that is
    not a layout/group container) into one of these. All technical fields are
    optional because the proprietary description format is best-effort.
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    id: str
    title: str
    node_type: str = Field(
        description="Raw diagram node type, e.g. 'aws-amazonaurora' or 'default'."
    )
    canonical_service: str = Field(
        description=(
            "Canonical AWS service name derived from node_type/title, "
            "e.g. 'aurora', 'elasticache', 'beanstalk', 's3', 'ec2-bastion'."
        )
    )

    role: str | None = None
    raw_config: str | None = None
    reason: str | None = None
    addresses: list[str] = Field(default_factory=list)

    instance_type: str | None = Field(
        default=None,
        description="EC2-style instance type, e.g. 'm6g.xlarge', 't3.small'.",
    )
    db_instance_class: str | None = Field(
        default=None,
        description="RDS/Aurora class, e.g. 'db.r5.2xlarge'.",
    )
    cache_node_type: str | None = Field(
        default=None,
        description="ElastiCache node type, e.g. 'cache.r6g.large'.",
    )
    warehouse_node_type: str | None = Field(
        default=None,
        description="Redshift node type, e.g. 'ra3.4xlarge'.",
    )

    storage_gb: float | None = None
    storage_type: str | None = Field(
        default=None, description="e.g. 'gp3', 'gp2', 'io2'."
    )

    count: int = Field(default=1, description="Minimum / baseline instance count.")
    max_count: int | None = Field(
        default=None, description="Maximum instance count if an ASG / scaling range."
    )

    multi_az: bool | None = None
    engine: str | None = Field(
        default=None,
        description="DB or cache engine, e.g. 'aurora-mysql', 'redis'.",
    )

    account: EnvironmentTier = "Unknown"
    region: str | None = None
    availability_zone: str | None = None
    parent_chain: list[str] = Field(
        default_factory=list,
        description="Ordered list of ancestor node IDs, root-most last.",
    )

    connected_to: list[str] = Field(default_factory=list)
    connected_from: list[str] = Field(default_factory=list)


class CostEstimateItem(BaseModel):
    """A single line item in the final cost breakdown."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    resource_id: str
    title: str
    service: str = Field(description="Canonical AWS service name.")
    account: EnvironmentTier = "Unknown"
    region: str | None = None

    instance_type: str | None = None
    quantity: int = 1

    monthly_cost_usd: float = Field(ge=0.0)
    unit_cost_usd: float | None = Field(
        default=None, ge=0.0, description="Per-unit monthly cost before quantity."
    )
    breakdown: str | None = Field(
        default=None,
        description="Human-readable, single-line breakdown of how the figure was built.",
    )
    confidence: ConfidenceLevel = "Medium"
    assumptions: list[str] = Field(default_factory=list)


class OverallState(TypedDict, total=False):
    """LangGraph state container.

    ``total=False`` means *every* key is optional, which lets each node return
    a partial dict and rely on LangGraph's default reducer to merge it into the
    running state. We intentionally keep this a plain ``TypedDict`` (not a
    Pydantic model) because LangGraph's runtime expects mapping-style merging.

    Reducer channels
    ----------------
    Most keys use LangGraph's default *last-write-wins* channel (``LastValue``).
    The exception is ``errors``: it is annotated with ``operator.add`` so that
    every stage's non-fatal issues are **concatenated** rather than
    overwritten. This is the standard Reducer / Fold pattern -- LangGraph
    inspects the ``Annotated[..., reducer]`` metadata at compile time and
    wires that key to a ``BinaryOperatorAggregate`` channel which applies
    ``reducer(prev, new)`` on every update.

    Why this matters for ``errors`` specifically
    --------------------------------------------
    Validation issues are emitted by *every* stage (parse, enrich, estimate,
    explain) and we need all of them to survive into the final response.
    With the default ``LastValue`` channel, each node's ``errors`` write
    would clobber the previous one and we would only ever see the last
    stage's complaints. ``operator.add`` on two lists is plain list
    concatenation (``[a] + [b] -> [a, b]``), giving us a monotonic,
    append-only audit log that is also race-safe under LangGraph's
    parallel-branch fan-in: when two branches merge, their per-branch
    ``errors`` lists are folded together by the same reducer.

    Node author contract
    --------------------
    To keep the reducer total (i.e. never raise), nodes that write to
    ``errors`` **must** return a ``list[str]`` -- never ``None``, never a
    bare string, never a tuple. ``operator.add(prev_list, None)`` would
    raise ``TypeError``; ``operator.add(prev_list, "oops")`` would silently
    decompose the string into a list of characters. The safe idioms are:

        # No errors this stage:
        return {"parsed_resources": [...]}

        # Or explicitly empty (also fine, it's a no-op concat):
        return {"parsed_resources": [...], "errors": []}

        # One or more errors:
        return {"errors": ["parse: missing 'nodes' in diagram"]}

    Complexity: each reducer application is ``O(len(prev) + len(new))``
    (Python list concatenation allocates a new list), so the total cost
    across the pipeline is ``O(E)`` in the total number of errors emitted.
    """

    raw_diagram: dict[str, Any]
    parsed_resources: list[ExtractedResource]
    infracost_results: dict[str, dict[str, Any]]
    final_costs: list[CostEstimateItem]
    total_monthly_cost: float
    architectural_explanation: str
    errors: Annotated[list[str], operator.add]
