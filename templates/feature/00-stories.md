# Feature Stories — <ticket> — <feature title>

> Author: requirements-analyst (returned output, persisted by orchestrator).
> BA deliverable: traceability, roles, anchored user stories, state machine,
> prerequisites, out-of-scope. Open/Decided questions live in 00-clarifications.md;
> the assumptions register lives in 01-assumptions.md.

## 1. Feature Overview

<one paragraph: what / who / why / scope boundary / phase; note any feature toggle>

## 2. Requirements Traceability

| Anchor | Req ID | Title | Original Phase | Delivery Phase | Actor(s) | Brief | Source |
|---|---|---|---|---|---|---|---|
| <a id="REQ-XXX-NN"></a>REQ-XXX-NN | XXX-NN | … | MVP / Future | V1 | … | … | [XXX-NN](path/to/spec#XXX-NN) |

## 3. Roles and Permissions

| Actor | What they do in this feature | Existing role? |
|---|---|---|
| … | … | Yes (maps to `<role>`) / No (new — data-only or model change?) |

## 4. User Stories

### Story Index

| Story ID | Group | Title | Actor |
|---|---|---|---|
| [XX-US-NN](#XX-US-NN) | … | … | … |

---

#### <a id="XX-US-NN"></a> XX-US-NN: <title>

**As a** <role>
**I want to** <action>
**So that** <outcome>

**Source Requirements:** [XXX-NN-AC-1](path/to/spec#XXX-NN-AC-1)

**Acceptance Criteria:**
- AC1: …

**Notes / Constraints:**
- …

## 5. State / Status Machine

> Only for workflow features. Diagram + a table of every named status constant.

| Status (named constant) | When it applies | New for platform? |
|---|---|---|
| … | … | Yes / No |

## 6. Platform & Data Prerequisites

- **Platform prerequisites:** shared-infra changes as their own prerequisite story (e.g. XX-US-00).
- **Data prerequisites:** seed data / config / new role records / templates — named, with owner.

## 7. Out of Scope

- Deferred: …
- Possibly mis-categorised (flag, don't drop): …
- Deliberately not handled: …
