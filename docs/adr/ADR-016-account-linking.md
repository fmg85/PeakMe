# ADR-016: Account linking — ownership follows the person, not the login method

**Date:** 2026-08-07
**Status:** Accepted

## Context

Supabase mints a **distinct `users` row per auth identity**. Sign in with Google and
then with a magic link, or with a work address and then a personal one, and you get
separate accounts. `get_current_user` auto-creates a row for any valid JWT, and the
email-fallback merge in ADR-009 only unifies accounts that share an email address —
which these do not.

Ownership is a single `projects.created_by` pointing at one `users.id`, so
`project.created_by == current_user.id` silently means *"the account you happen to be
signed in as right now"*, not *"you"*.

This was not hypothetical. In production on 2026-08-07:

| Human | Accounts | Projects | Annotations |
|---|---|---|---|
| Brother | `geier@stanford.edu` (Google), `benedikt.k.geier@gmail.com` | 5 + 1 | 72,822 |
| Owner | `flori@ngeier.com`, `florianmgeier@gmail.com` (Google) | 3 + 0 | 60 |

One person's 37 datasets sat under two identities, split 27/10. Whether a delete
succeeded depended on which button they pressed to sign in. `delete_project` has
enforced ownership since the beginning, so this had been latent for months; the
2026-08-07 dataset-delete guard (closing an unauthenticated-delete hole) extended the
same asymmetry to all 47 datasets and made it impossible to ignore.

The institutional cause is worth recording: a Stanford address could not receive the
Supabase magic-link email, so a Google account was created alongside it. Multiple
identities per person is normal, not user error.

## Decision

Add a nullable **`users.identity_group_id`**. Accounts sharing a non-NULL value are
the same person. NULL means "this account is its own identity".

All ownership checks route through one function, `app/services/ownership.py`:

```python
async def can_modify_project(db, project, user) -> bool:
    if user.is_admin: return True
    if project.created_by == user.id: return True     # fast path, no query
    return project.created_by in await identity_ids(db, user)
```

Three call sites use it: `delete_project`, `update_project`, `delete_dataset`.

Why this shape:

- **Additive and inert.** A nullable column with no backfill. Every existing row is
  NULL, so behaviour is identical until a group is deliberately assigned. Nothing to
  migrate, nothing to lose, and `downgrade` is a clean drop.
- **NULL is not a group.** The equality test is against a non-NULL `identity_group_id`,
  and the `user.identity_group_id is None` branch short-circuits to `{user.id}`. If
  NULL matched NULL, the migration would instantly make **every user an owner of every
  project**. There is a test pinning exactly this.
- **Attribution is untouched.** Annotations keep pointing at the account that made
  them. Linking answers "may this person modify that project", not "who annotated
  this". Merging the rows instead would rewrite 72,888 annotations, destroy the
  provenance, and *still* not prevent recurrence — a new sign-in method would mint a
  fresh account tomorrow.
- **One place to extend.** Multi-user support means changing this one function, not
  hunting `created_by` comparisons across routers.

Applied only to the guarded mutations. Reads, uploads, and label editing stay
deliberately shared between signed-in users (see `tests/test_projects.py`); gating
those would break collaboration rather than harden anything.

## Consequences

- A person with several accounts sees consistent permissions however they sign in.
- Linking is a data operation (`UPDATE users SET identity_group_id = … WHERE email IN …`),
  reversible by setting the column back to NULL. There is intentionally no UI: it is
  rare, sensitive, and wrongly linking two *different* people would hand one control of
  the other's projects.
- `is_admin` still overrides everything and remains the emergency lever.
- Auto-linking on matching *verified* email is deliberately NOT done — that is how
  account-takeover bugs get written. Linking stays explicit and manual.
- Covered by 8 tests: cross-identity delete/rename, strangers still refused, groups not
  bleeding into each other, NULL not linking everyone, unlinked owners unaffected, and
  admin override.

## Alternatives considered

- **Merge duplicate accounts into one row.** Destructive on 72,888 annotations, loses
  per-account provenance, and does not prevent recurrence.
- **`project_members` table.** The right model for *sharing between different people*,
  and orthogonal to this — a person is still not the same as an account. Composes
  cleanly on top of `can_modify_project` when real multi-user arrives.
- **Grant `is_admin` to both accounts.** One `UPDATE`, no code — but it hands each
  account full control of *everyone's* projects to work around a modelling gap, and
  leaves the gap in place for the next person.
