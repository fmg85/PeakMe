# ADR-008: Global Stats API endpoint

**Date:** 2026-04-01
**Status:** Accepted

## Context

The per-project stats endpoint (`GET /api/projects/{id}/stats`) shows annotation
progress for a single project. Researchers wanted a sense of platform-wide activity —
how many ions have been annotated across *all* projects and by how many people — to
build community context and motivation.

## Decision

Add a second stats router (`global_router`) with a single endpoint:

```
GET /api/stats
```

Returns `GlobalStatsOut`:
- `total_ions` — sum of all ions across all datasets/projects
- `total_annotations` — count of all annotation rows platform-wide
- `unique_annotators` — distinct user count
- `label_distribution` — aggregated label counts across all projects

**Authentication:** The endpoint requires a valid JWT (`CurrentUser` dependency).
Unauthenticated callers receive 401. This prevents public enumeration of annotation
volume.

**Privacy:** Only aggregate counts are returned — no per-user breakdown, no project
names, no ion images. Individual annotator identities are not exposed.

**Code location:** `backend/app/routers/annotations.py` (`global_router`)  
**Frontend:** `StatsPage.tsx` — "PeakMe Community" section at the bottom of the stats page.

## Consequences

**Positive:**
- Adds a motivating community context card to every project's stats page.
- No schema changes; queries the existing `annotations`, `ions`, `datasets`, `projects`
  tables with a simple aggregation.

**Negative:**
- Any authenticated user can see platform-wide annotation volume (not scoped to their
  projects). Acceptable for a research annotation tool with a small trusted user base.
- If the platform scales to many projects, the unindexed aggregation query may become
  slow. Mitigation: add a materialised view or caching layer at that point.

## Alternatives Considered

- **No access control (public endpoint):** Rejected — exposes annotation volume without
  even a minimal auth check.
- **Scope to projects the user is a member of:** More private but more complex. The
  current user base is small and all users work in the same research group. Deferred.
