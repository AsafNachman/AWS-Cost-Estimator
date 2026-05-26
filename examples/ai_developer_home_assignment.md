# Home Assignment: AWS Infrastructure Cost Estimator

## Overview

You are tasked with building an AI-powered web application that accepts a proprietary JSON diagram describing an AWS cloud infrastructure and returns a **cost estimation** for that infrastructure, along with a human-readable explanation.

This assignment evaluates your ability to work with modern AI tooling, build full-stack applications, and design clean, production-oriented systems.

---

## The Task

### Core Requirement — Cost Estimator
- Accept a JSON payload representing a proprietary cloud infrastructure diagram (format described below)
- Parse and analyze the described AWS resources and their configurations
- Use an LLM-powered backend to produce a **cost estimation breakdown** — per service and in total, in USD/month
- Display the results in a clear, well-structured UI

### Bonus — Infrastructure Explainer
- Produce a **plain-language explanation** of what the infrastructure does, how its components relate to each other, and any notable architectural patterns or concerns
- Present this in a readable, visually appealing format (collapsible sections, grouped by concern: compute, storage, networking, security, analytics, etc.)

---

## Input Format — Proprietary Diagram Schema

The input is a JSON object in our internal diagram format. It is structured as a **node-edge graph** (similar to React Flow) with AWS-specific metadata.

### Top-level structure

```json
{
  "id": "string",
  "name": "string",
  "nodes": [ ...Node[] ],
  "edges": [ ...Edge[] ]
}
```

---

### Node object

Each node represents either an **AWS resource** or a **layout group** (region, VPC, subnet, account, zone).

```json
{
  "id": "string",           // Unique node identifier (often slug-style, e.g. "beanstalk-us-east-1-az-a")
  "type": "string",         // Node type (see Type Reference below)
  "title": "string",        // Human-readable display name
  "description": "string",  // Structured metadata (Role / Config / Reason / Addresses)
  "parentId": "string",     // ID of the containing group node (omitted for top-level nodes)
  "position": { "x": number, "y": number },
  "width": number,
  "height": number
}
```

#### Node type reference

| Type prefix | Meaning |
|---|---|
| `aws-group-awscloud` | Top-level AWS Cloud boundary |
| `aws-group-region` | AWS Region container |
| `aws-group-virtualprivatecloudvpc` | VPC container |
| `aws-group-publicsubnet` | Public subnet container |
| `aws-group-privatesubnet` | Private subnet container |
| `genericzone` | Generic logical grouping (e.g. "Security & Compliance", "Analytics", account boundaries) |
| `aws-elasticbeanstalk` | AWS Elastic Beanstalk environment |
| `aws-amazonaurora` | Amazon Aurora DB cluster |
| `aws-amazonelasticache` | Amazon ElastiCache (Redis/Memcached) |
| `aws-amazonredshift` | Amazon Redshift cluster |
| `aws-amazons3` | Amazon S3 bucket |
| `aws-amazonefs` | Amazon EFS file system |
| `aws-elasticloadbalancing` | Application / Network Load Balancer |
| `aws-amazondatafirehose` | Amazon Kinesis Data Firehose |
| `aws-amazoncloudwatch` | Amazon CloudWatch |
| `aws-amazonsimplenotificationservice` | Amazon SNS |
| `aws-transitgateway` | AWS Transit Gateway |
| `aws-keymanagementservice` | AWS KMS |
| `aws-secretsmanager` | AWS Secrets Manager |
| `aws-databasemigrationservice` | AWS DMS |
| `aws-cloudtrail` | AWS CloudTrail |
| `aws-amazonguardduty` | Amazon GuardDuty |
| `aws-securityhub` | AWS Security Hub |
| `aws-amazoninspector` | Amazon Inspector |
| `aws-auditmanager` | AWS Audit Manager |
| `aws-backup` | AWS Backup |
| `aws-waf` | AWS WAF |
| `aws-shield` | AWS Shield |
| `aws-certificatemanager` | AWS Certificate Manager |
| `aws-amazonroute53` | Amazon Route 53 |
| `aws-amazoncloudfront` | Amazon CloudFront |
| `aws-identityandaccessmanagement` | AWS IAM |
| `aws-organizations` | AWS Organizations |
| `aws-controltower` | AWS Control Tower |
| `aws-amazonec2` | Amazon EC2 instance |
| `aws-glue` | AWS Glue |
| `aws-amazonquicksight` | Amazon QuickSight |
| `aws-amazonathena` | Amazon Athena |
| `aws-xray` | AWS X-Ray |
| `aws-stepfunctions` | AWS Step Functions |
| `aws-privatelink` | AWS PrivateLink / VPC Endpoints |
| `aws-iamidentitycenter` | AWS IAM Identity Center (SSO) |
| `aws-budgets` | AWS Budgets |
| `aws-computeoptimizer` | AWS Compute Optimizer |
| `default` | Generic/third-party resource (e.g. Jenkins, Sophos UTM, DataDog) |
| `user` | External actor / user persona |

#### The `description` field

When present, the `description` field follows a structured multi-line format:

```
Role: What this resource does in this architecture.
Config: Key configuration parameters (instance type, storage, scaling rules, etc.).
Reason: Why this service was selected (often references requirements).
Addresses: REQ-XXX, REQ-YYY  (or N/A)
```

This field is the richest source of configuration detail for cost estimation. Parse it carefully — it contains instance types, node counts, storage sizes, and pricing models.

---

### Edge object

Each edge represents a relationship or data flow between two nodes.

```json
{
  "id": "string",
  "source": "string",           // Source node ID
  "target": "string",           // Target node ID
  "label": "string",            // Human-readable description of the flow
  "animated": boolean,          // true = active/live data flow; false = configuration/passive relationship
  "style": {
    "strokeDasharray": "3 3"    // When present, indicates a cross-cutting concern (security, encryption, monitoring)
  }
}
```

**Edge semantics to be aware of:**
- Animated, solid lines → active data flows (requests, queries, streaming)
- Non-animated, solid lines → deployment or operational relationships (deploy, backup, collect)
- Dashed lines (`strokeDasharray`) → cross-cutting concerns: encryption (KMS), security inspection (WAF), monitoring collection, compliance

---

### Hierarchy via `parentId`

Nodes nest hierarchically:

```
aws-cloud
  └── region (aws-group-region)
        ├── Regional Services zone (genericzone)
        │     └── transit-gateway, cloudtrail, cloudwatch, s3, ...
        ├── Security & Compliance zone (genericzone)
        │     └── guardduty, inspector, security-hub, kms, ...
        ├── Account zone (genericzone)
        │     └── VPC (aws-group-virtualprivatecloudvpc)
        │           ├── Public Subnet (aws-group-publicsubnet)
        │           │     └── load-balancer, bastion-host, ...
        │           ├── Private App Subnet (aws-group-privatesubnet)
        │           │     └── beanstalk, secrets-manager, ...
        │           └── Private Data Subnet (aws-group-privatesubnet)
        │                 └── aurora, elasticache, efs, ...
        └── Analytics & Monitoring zone (genericzone)
              └── redshift, glue, quicksight, athena, ...
```

**Important:** Group nodes (`aws-group-*`, `genericzone`) carry no direct cost — they are layout containers only. Cost is derived from leaf resource nodes.

---

## Example Diagrams

Three representative example diagrams are included in this repository (see `/examples/`). They all describe variations of the same gaming platform AWS architecture — a multi-account setup with Production, Management/Deployment, and Dev/QA environments — and demonstrate:

- Multi-account, multi-VPC topologies
- Elastic Beanstalk with multi-AZ deployments
- Aurora MySQL with read replicas
- Kinesis → Redshift analytics pipelines
- Security layers (WAF, Shield, GuardDuty, KMS, Secrets Manager)
- CI/CD via Jenkins + Sophos UTM egress filtering

Use these to test your system. Your solution should handle any diagram in this schema, not just these specific examples.

---

## Tech Stack

You **must** use the following technologies:

### Frontend
| Layer | Technology |
|---|---|
| Framework | Next.js (App Router) |
| UI | React + TypeScript |
| Styling | Your choice (Tailwind CSS recommended) |

### Backend
| Layer | Technology |
|---|---|
| API Server | FastAPI |
| AI Orchestration | LangGraph + LangChain |
| Database *(if used)* | MongoDB |

Use any LLM provider you prefer (OpenAI, Anthropic, etc.). Document the required API key in the README.

---

## Requirements

### Functional
- [ ] Web UI with a JSON input area (text editor or file upload)
- [ ] Submit action that sends the diagram to the backend for analysis
- [ ] Cost estimation result view, broken down by resource with a total
- [ ] Graceful handling of invalid, incomplete, or unsupported JSON
- [ ] *(Bonus)* Plain-language infrastructure explanation view
- [ ] *(Bonus)* Persist submitted diagrams and results (MongoDB)
- [ ] *(Bonus)* Display cost confidence indicators (e.g. "estimate based on known config" vs "assumed defaults")

### Non-Functional
- [ ] The backend **must use LangGraph** to manage the AI workflow — with distinct, meaningful nodes (e.g. parse → enrich → estimate → explain)
- [ ] Code must be typed and reasonably documented
- [ ] A `README.md` must be included with complete setup and run instructions

---

## Evaluation Criteria

| Area | What We're Looking For |
|---|---|
| **AI Architecture** | Thoughtful use of LangGraph — clear node separation, well-structured state, good prompting strategy |
| **Schema Comprehension** | Does the system correctly extract and interpret resources and their configurations from the real schema? |
| **Estimation Quality** | Are the cost estimates reasonable? Does the LLM reason well about instance types, counts, and pricing tiers? |
| **Full-Stack Quality** | Clean API design, proper TypeScript typing, sensible component structure |
| **UX & UI** | Are results easy to read? Is the output well-organized? |
| **Code Quality** | Readable, maintainable, consistent style |
| **Bonus Features** | Quality of the explanation view, persistence, confidence signals, extra polish |
| **README** | Can we run this in under 5 minutes from scratch? |

---

## Submission

Submit a link to a **GitHub repository** (public, or shared with us) containing:

- Full source code for frontend and backend
- A `README.md` with setup instructions and a brief write-up of your design decisions
- An `/examples/` folder with the three provided diagram JSON files (and any additional ones you created for testing)

A short Loom or written walkthrough is welcome but not required.

**Time expectation:** This assignment is designed to take approximately **4–8 hours**. A focused, well-executed solution is preferred over a sprawling one.

---

## Tips

- Start with the LangGraph architecture — it's the core of what we're evaluating. Think carefully about your node boundaries: parsing the schema is a distinct step from estimating costs, which is distinct from generating an explanation.
- The `description` field on nodes is your richest source of ground truth. A good parsing step extracts instance types, counts, and storage sizes from it.
- Group/layout nodes (`aws-group-*`, `genericzone`) have no cost — filter them early.
- You don't need to call the live AWS Pricing API. Having the LLM reason about approximate costs from its knowledge is acceptable. Integrating a real pricing source is a strong bonus.
- The `parentId` hierarchy tells you which account and VPC a resource lives in — useful for contextualizing multi-environment architectures (Prod vs Dev/QA vs Management).
- Dashed edges indicate cross-cutting concerns (encryption, security, monitoring) — they're less relevant to cost but very useful for the explanation bonus.

Good luck — we're excited to see what you build!
