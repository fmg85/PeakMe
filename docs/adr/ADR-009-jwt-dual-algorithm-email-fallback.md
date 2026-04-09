# ADR-008: JWT Verification — Dual-Algorithm (ES256 + HS256) with Email-Fallback User Lookup

**Date:** 2026-04-01
**Status:** Accepted

## Context

Two separate issues arose with the Supabase JWT verification in `backend/app/deps.py`:

**1. ES256 vs HS256 algorithm mismatch**

Supabase migrated JWT signing from HS256 (shared secret) to ES256 (ECDSA P-256 asymmetric key) during a platform-wide key rotation. Tokens issued before the rotation are HS256; tokens issued after are ES256. A backend that only handles one algorithm rejects valid tokens from the other era.

**2. Google OAuth creates a different Supabase UUID for the same email**

When a user first signs in via email OTP, Supabase creates a user record with UUID A. If Supabase account-linking is not enabled and the same user later signs in via Google OAuth with the same email address, Supabase may create a *second* user record with UUID B. The backend's `get_current_user` looked up users by UUID only, so the Google login produced a new user record — causing a `UNIQUE` constraint violation on `users.email` and a 500 error.

## Decision

### JWT verification (`_verify_token`)

Inspect the JWT header's `alg` field before verification:

- **ES256:** Fetch the public key from Supabase's JWKS endpoint
  (`<supabase_url>/auth/v1/.well-known/jwks.json`), matched by `kid`. Cache the JWKS
  for 1 hour to avoid a round-trip on every request. Verify with `jose`.
- **HS256:** Verify with the `SUPABASE_JWT_SECRET` (shared secret from Supabase settings).

Any exception during verification — including JWKS network failures (`httpx.HTTPError`)
which `JWTError` does not catch — is caught by a broad `except Exception` and converted
to HTTP 401 so the frontend sees a clear auth failure rather than a 500.

### Email-fallback user lookup (`get_current_user`)

After extracting `sub` (UUID) and `email` from the verified payload:

1. Look up `User` by UUID. If found → done.
2. If not found **and** email is present → look up `User` by email.
   - If found: this is the same person who previously registered via a different auth
     method. Return their existing record (same permissions, same projects).
   - As a bonus: if the stored `display_name` still matches the email prefix
     (auto-generated on first OTP signup, e.g. `"geier"`) and the Google JWT carries a
     richer `full_name` in `user_metadata`, update `display_name` automatically so the
     user gets their real name without manual action.
3. If still not found → auto-create a new `User` from the JWT claims.

All of this runs inside a `try/except` block; any unexpected error returns 401.

**Code location:** `backend/app/deps.py`

## Consequences

**Positive:**
- Zero session disruption when Supabase rotates signing keys.
- Google OAuth and email OTP users with the same email address share a single PeakMe
  account and see the same projects.
- JWKS is cached; no per-request network overhead after the first call.
- Display names are synced from Google profiles automatically.

**Negative:**
- The email fallback silently merges accounts. If two *different* people somehow share a
  Supabase email (edge case), they would be merged into one PeakMe account. Mitigation:
  enable Supabase account-linking in the Supabase dashboard — this prevents duplicate
  UUID issuance for the same email entirely and makes the fallback unnecessary.
- JWKS cache TTL is 1 hour; a key rotation within the cache window would cause
  verification failures until the cache expires. Acceptable trade-off given Supabase's
  key rotation cadence (rare, announced in advance).

## Alternatives Considered

- **ES256 only:** Would break any user still holding an HS256 token (or any deployment
  that hasn't rotated keys). Rejected.
- **HS256 only:** Would break new tokens after Supabase's key rotation. Rejected.
- **Force re-login on UUID mismatch:** Would frustrate users who signed in via OTP first
  and later used Google. Rejected in favour of the transparent email fallback.
- **Enable Supabase account-linking:** The correct long-term solution. The email fallback
  is a belt-and-suspenders measure that works even if account-linking is not configured.
