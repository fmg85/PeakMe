"""Account linking: ownership follows the person, not the login method.

Supabase mints a distinct user row per auth method and per email address, so one
human routinely holds several accounts (magic-link vs Google, work vs personal
address). Ownership stores a single users.id, so before linking, whether a delete
succeeded depended on which button someone pressed to sign in — a real, live split
in production, where one person's projects sat under two different accounts.

Accounts sharing a non-NULL identity_group_id are treated as the same person.
NULL (the default for every pre-existing row) means "its own identity", so this is
inert until a group is assigned.
"""
import uuid

from tests.factories import make_dataset, make_project, make_user


async def _link(db, *users):
    """Put the given accounts in one identity group, as one person."""
    group = uuid.uuid4()
    for u in users:
        u.identity_group_id = group
        db.add(u)
    await db.commit()
    for u in users:
        await db.refresh(u)
    return group


async def test_linked_account_can_delete_the_others_project(client, db, login_as):
    google = await make_user(db, email="someone@work.edu")
    magic_link = await make_user(db, email="someone@gmail.com")
    await _link(db, google, magic_link)
    project = await make_project(db, google)   # created while signed in via Google
    login_as(magic_link)                        # now signed in the other way

    r = await client.delete(f"/api/projects/{project.id}")

    assert r.status_code == 204


async def test_linked_account_can_delete_the_others_dataset(client, db, login_as):
    google = await make_user(db)
    magic_link = await make_user(db)
    await _link(db, google, magic_link)
    project = await make_project(db, google)
    dataset = await make_dataset(db, project)
    login_as(magic_link)

    r = await client.delete(f"/api/datasets/{dataset.id}")

    assert r.status_code == 204


async def test_linked_account_can_rename_the_others_project(client, db, login_as):
    a = await make_user(db)
    b = await make_user(db)
    await _link(db, a, b)
    project = await make_project(db, a)
    login_as(b)

    r = await client.patch(f"/api/projects/{project.id}", json={"name": "Renamed"})

    assert r.status_code == 200


async def test_unlinked_stranger_is_still_refused(client, db, login_as):
    """Linking must not become a hole: a different person stays locked out."""
    owner = await make_user(db)
    partner = await make_user(db)
    await _link(db, owner, partner)
    stranger = await make_user(db)          # identity_group_id stays NULL
    project = await make_project(db, owner)
    dataset = await make_dataset(db, project)
    login_as(stranger)

    assert (await client.delete(f"/api/projects/{project.id}")).status_code == 403
    assert (await client.delete(f"/api/datasets/{dataset.id}")).status_code == 403


async def test_different_groups_do_not_bleed_into_each_other(client, db, login_as):
    a1 = await make_user(db)
    a2 = await make_user(db)
    await _link(db, a1, a2)
    b1 = await make_user(db)
    b2 = await make_user(db)
    await _link(db, b1, b2)
    project = await make_project(db, a1)
    login_as(b2)

    r = await client.delete(f"/api/projects/{project.id}")

    assert r.status_code == 403


async def test_null_group_does_not_link_everyone(client, db, login_as):
    """The critical regression: NULL is 'no group', not 'a group of all NULLs'.

    Every row in production has identity_group_id NULL. If NULL matched NULL this
    migration would silently make every user an owner of every project.
    """
    owner = await make_user(db)
    other = await make_user(db)
    assert owner.identity_group_id is None and other.identity_group_id is None
    project = await make_project(db, owner)
    dataset = await make_dataset(db, project)
    login_as(other)

    assert (await client.delete(f"/api/projects/{project.id}")).status_code == 403
    assert (await client.delete(f"/api/datasets/{dataset.id}")).status_code == 403


async def test_owner_still_works_unlinked(client, db, login_as):
    """The unlinked fast path must be unaffected."""
    owner = await make_user(db)
    project = await make_project(db, owner)
    dataset = await make_dataset(db, project)
    login_as(owner)

    assert (await client.delete(f"/api/datasets/{dataset.id}")).status_code == 204
    assert (await client.delete(f"/api/projects/{project.id}")).status_code == 204


async def test_admin_still_overrides_regardless_of_group(client, db, login_as):
    owner = await make_user(db)
    admin = await make_user(db, is_admin=True)
    project = await make_project(db, owner)
    login_as(admin)

    assert (await client.delete(f"/api/projects/{project.id}")).status_code == 204
