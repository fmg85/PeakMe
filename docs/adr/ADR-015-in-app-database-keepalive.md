# ADR-015: Move the database keepalive into the API process

**Date:** 2026-08-07
**Status:** Accepted

## Context

The Supabase free tier **pauses a project after ~1 week of inactivity** (noted as a
consequence back in ADR-002). A paused project takes the API — and every annotation
in it — offline until someone restores it by hand.

The only thing preventing that was a `curl /keepalive` step inside the **nightly
scheduled GitHub Actions job** in `deploy.yml` (`cron: '0 3 * * *'`).

That mechanism has a failure mode that is easy to miss, and it surfaced on
2026-08-07 when GitHub emailed:

> The "Deploy to EC2" workflow in fmg85/PeakMe will be disabled soon.
> Scheduled workflows are disabled automatically after 60 days of repository inactivity.

At that point `main` had been dormant for 53 days. The resulting chain is:

```
repo dormant 60 days
  → GitHub disables the schedule: trigger
    → nothing calls /keepalive
      → Supabase pauses after ~7 more days
        → app offline, annotation data inaccessible until manually restored
```

The critical property is that **the mechanism fails exactly when it is most needed**.
A quiet repository is precisely the situation in which the database is also idle, so
the keepalive disappears at the very moment it is load-bearing.

It also cannot be fixed with more GitHub Actions: a scheduled workflow added to keep
the repository "active" would be governed by the same 60-day rule and disabled
alongside the first one. Any repo-activity-based scheme is self-defeating.

Note the blast radius is limited to the *scheduled* trigger. `push:` and
`workflow_dispatch:` are never auto-disabled, so ordinary deploys keep working — which
is what makes this failure quiet rather than obvious.

## Decision

**The API process pings its own database on a timer.**

`backend/app/main.py` starts `_keepalive_loop()` from a FastAPI `lifespan` handler.
Every `KEEPALIVE_INTERVAL_SECONDS` (6h) it opens a session and issues `SELECT 1`.

- The API runs 24/7 on EC2 under Docker with `restart: unless-stopped`, so its
  availability is independent of GitHub, of repository activity, and of CI.
- Failures are logged and swallowed — a transient DB blip must not kill the loop,
  because a dead loop silently stops protecting the database (the same class of
  quiet failure this ADR exists to remove).
- The task is cancelled on shutdown so it does not leak across reloads.
- 6h against a ~1 week pause threshold is a ~28× margin, so several consecutive
  failed pings are still harmless.

Both gunicorn workers run their own loop. Two `SELECT 1`s every 6h is irrelevant
load, and the redundancy is mildly useful, so this is left alone rather than adding
leader-election complexity.

The `GET /keepalive` endpoint and the nightly `curl` are **kept**, now as a
belt-and-braces secondary path rather than the primary mechanism. The nightly job
retains real value for its other purpose — the catch-up redeploy when a
push-triggered deploy failed.

## Consequences

- The database no longer depends on GitHub Actions being enabled, or on anyone
  pushing commits, to stay awake.
- If GitHub disables the schedule after 60 days of dormancy, the only thing lost is
  the catch-up redeploy — a convenience, not an availability mechanism. Re-enable it
  from the Actions tab; any push also resets the 60-day counter.
- The app now performs a small amount of background work when otherwise idle. This is
  intentional and is the point.
- Covered by `backend/tests/test_keepalive.py`, which asserts the loop pings on each
  interval, **survives DB errors**, is actually started and cancelled by the lifespan,
  and keeps a wide margin under the pause threshold.

## Alternatives considered

- **A cron job on the EC2 box** (`crontab` → `curl localhost:8000/keepalive`). Equally
  independent of GitHub, but it lives outside the repo, is not covered by tests, and
  is lost on instance replacement. The deploy already documents one crontab entry for
  certbot; adding undocumented drift-prone host state was not worth it.
- **An external uptime monitor** (UptimeRobot etc.) hitting `/keepalive`. Works, but
  adds a third-party dependency and another account to keep alive.
- **Upgrading to Supabase Pro** ($25/mo), which has no inactivity pause. The correct
  fix if PeakMe ever carries data that matters commercially; not justified yet. ADR-002
  already flags this as the pre-production upgrade path.
- **A scheduled workflow that commits to keep the repo active.** Self-defeating, as
  described above, and it would pollute history.
