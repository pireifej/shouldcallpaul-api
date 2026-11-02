# CRM workshop ↔ résumé workshop links — frontend integration

## Public versus private

One CRM workshop can link to multiple résumé workshop entries, and any résumé
entry can link to multiple CRM workshops. All identifiers are existing permanent
IDs: integer CRM workshop `id`, string résumé workshop `id`.

These endpoints use existing CRM authentication and `{success:true,data:...}`.
Keep credentials server-side. No frontend changes are implemented here.

## Endpoints

| Method | URL | Purpose |
|---|---|---|
| GET | `/api/workshops/:id/resume-entries` | Read all linked résumé IDs |
| POST | `/api/workshops/:id/resume-entries` | Add one link |
| DELETE | `/api/workshops/:id/resume-entries/:resume_entry_id` | Remove only that link |

POST body: `{"resume_entry_id":"permanent-resume-workshop-id"}`. No other fields
are accepted. URL-encode the résumé ID in DELETE paths.

All three return:

```json
{
  "success": true,
  "data": {
    "workshop_id": 42,
    "resume_entry_ids": ["first-permanent-id", "second-permanent-id"]
  }
}
```

IDs are deduplicated and lexically sorted (not delivery order or primary order).
Repeated adds/removes are idempotent and return 200. Removing an absent link is
a no-op. POST accepts existing draft or published résumé workshop IDs only.

Errors: 400 invalid CRM ID/body or unknown résumé ID on add; 404 missing CRM
workshop; 401 invalid/missing authentication; 409 concurrent FK conflict; 503
schema awaiting Publish. Failed operations are rolled back.

Existing `GET /api/workshops`, `GET /api/workshops/:id`, and workshop
create/update/status responses now include **read-only `resume_entry_ids`**.
Use this array for link chips/selection; do not rely on the legacy single field.
Writing `resume_entry_ids` through create/update is rejected with 400; use the
dedicated link endpoints instead.

`GET /api/workshops?resume_entry_id=<URL-encoded-ID>` now returns all CRM
workshops linked to that résumé entry, whether via the old field or new links.
Use authenticated `GET /api/resume/workshops` to load selection options, including
drafts. Use management record `id` as the permanent ID and `entry.label` for
display. Public `/resume/workshops` remains published-only and unchanged.

## Backward compatibility and preservation

`resume_entry_id` remains the legacy single nullable slot. It is not necessarily
the first item in `resume_entry_ids`.

- Existing links remain exactly where they were; no destructive backfill.
- Effective links are the union of the legacy slot and the additive junction
  table `crm_workshop_resume_links`, deduplicated.
- Old create/PUT/PATCH requests keep their meaning: omitted single field is
  unchanged, null clears the legacy slot, a valid string replaces that slot.
- Old writes never clear additional links. Clearing every link requires explicitly
  removing every returned ID with DELETE.
- Dedicated DELETE removes that specific ID from both storage locations.
- The new POST never changes the legacy slot.
- Linking does not change status, notes, fees, contacts, sessions, activity logs,
  timestamps, publication, résumé content, or the public tally.
- Removing the legacy slot may produce an existing workshop audit change; this
  is not a copied activity log. No CRM history is duplicated into résumé entries.
- Complete remains editable. Status does not automatically publish or create
  résumé entries. No automatic title matching.
- Linked résumé entries cannot be deleted until unlinked (409). Explicit CRM
  workshop deletion removes only its junction rows; existing session/activity
  deletion protections remain.
- Public feeds do not expose the junction, CRM IDs, notes, contacts, fees or logs.

## Schema rollout

`migrations/workshop-resume-links.sql` adds only a table, composite primary key,
foreign keys and an index. Development preparation applies it even after the
original résumé import has completed. It does not re-import JSON or overwrite
existing content.

Apply development setup with `node scripts/prepare-portfolio-development.js`,
then review Publish's schema diff and publish normally. No production DDL,
production data backfill, deploy-time migration hook or startup DDL is added.
Existing legacy links remain readable/writable before the table is published.
New link endpoints explicitly return 503 until the table exists. Schema capability
is checked read-only and cached for the server lifetime; restart after an
out-of-band schema change. A normal publish starts the new server after migration.

Pray Over Us tables and data are not part of this migration.
