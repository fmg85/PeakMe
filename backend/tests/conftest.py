"""Shared pytest fixtures for the PeakMe backend test suite.

The suite is intentionally small and risk-based — it covers only the boundaries
listed under "Testing" in CLAUDE.md (auth, ingestion, migrations, the export CSV
contract, and the ownership 403), not broad surface area.

Fixtures (DB session against an ephemeral Postgres, an httpx AsyncClient with a
mocked verifier, in-memory ZIP builders, etc.) will be added here as the first
tests land. See docs/adr/ADR-013-deploy-gated-ci.md.
"""
