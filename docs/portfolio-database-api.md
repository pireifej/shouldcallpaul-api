# Database-backed résumé and workshop management

## Ownership and migration

This backend owns the public résumé feeds and the CRM data. Both now use the
existing CRM database (`auditPool`, configured using `NEON_DATABASE_URL`).
This does not replace the prayer database or move CRM data to another provider.

Development schema preparation runs via
`node scripts/prepare-portfolio-development.js` and the post-merge setup hook.
It targets **development `DATABASE_URL` only**, never `NEON_DATABASE_URL`.
`portfolio/migrate.js` performs an advisory-locked, transactional import. It:

1. Creates category-specific résumé tables, workshop relationships, and speaker-menu tables.
2. Imports all ten `resume_data/*.json` files and `speaker_data/speaker_menu.json`.
3. Compares every reconstructed feed with its original, including field presence,
   capitalization, HTML, links, nulls, order, galleries, and workshop sessions.
4. Installs the résumé workshop FK and change-history triggers.
5. Writes a durable completion marker and counts in `portfolio_migrations`.

A failure rolls everything in this migration back. Replit Publish compares this
prepared development schema to production and applies schema changes through the
Publish UI. Do not approve DROP statements for these tables or use the option
to overwrite production data with development data.

The existing CRM production database already contains the verified initial import.
Runtime startup now performs **read-only readiness checks**; it does not create
portfolio tables, add constraints, run seed imports, or recreate deleted content
in production. Missing schema/import markers cause an explicit startup failure.
For a genuinely new production database, plan its initial data import separately;
do not silently seed or overwrite a populated production database.

Functions/triggers are also required for relationships and history. They are
already installed in the existing CRM database; do not assume Publish creates
unsupported database objects in a new production database automatically.

The old JSON files are **one-time migration inputs/backups only**. They remain in
the repository to bootstrap a database on a first deployment; they are not a
fallback, a second editable source, or used to validate links or build AI prep.
Do not edit them to manage content. Remove them only in a later deployment after
all intended databases have imported successfully and an independent backup is
available. Images and other static media remain at their existing URLs.

## Data model

Each résumé category has its own table and typed columns for its existing fields.
Structured display `details`, galleries, and technology lists use JSONB database
columns; they are not flat files. Original field presence is retained separately
so legacy public feeds do not acquire unwanted empty fields.

| Feed category | Database table | Public wrapper |
|---|---|---|
| workshops | resume_workshops | records |
| speech | resume_speeches | records |
| conference | resume_conferences | records |
| hackathon | resume_hackathons | records |
| patent | resume_patents | records |
| projects | resume_projects | records |
| races | resume_races | records |
| awards | resume_awards | records |
| certificates | resume_certificates | certifications |
| testimonials | resume_testimonials | records |

Workshop relationships:
- `crm_organizations` → many `crm_workshops` through `organization_id`.
- `crm_events` groups engagements at an event; workshops have nullable `event_id`.
- `crm_workshop_sessions.workshop_id` → a particular CRM workshop, with dates,
  time zones, duration, attendance, venue, and notes.
- Existing `crm_workshop_contacts` remains the many-to-many workshop/contact link.
- `crm_organization_contacts` allows multiple contacts per organization and
  multiple organizations per contact. Existing contact organization text remains intact.
- `crm_activity_logs.workshop_id` is a direct FK. Existing valid workshop logs
  are backfilled. Historical orphan logs are retained unchanged and counted in
  the migration report, not discarded or assigned to an invented workshop.
- `crm_workshops.resume_entry_id` is a nullable, non-unique FK to
  `resume_workshops.id`. Multiple private engagements may summarize into one
  curated public entry.
- `resume_workshop_sessions.resume_entry_id` stores the public entry's session
  breakdown separately from private CRM sessions.

**No automatic merging by workshop title, auto-publication on Complete, copying
private history into public content, or combined CRM/résumé tally.** Importing a
public workshop does not manufacture a private CRM engagement or guess its
organization. Existing CRM organization names are grouped by **exact name only**;
case variations remain separate for deliberate correction.

## Authentication and response envelopes

All `/api/...` endpoints below use the existing CRM `authenticate` middleware.
Use the same credentials/header handling as existing `/api/workshops` calls.
Public feeds require no CRM authentication.

Success: `{ "success": true, "data": ... }`.
Failure: `{ "success": false, "error": "..." }`.
Validation errors are 400, missing records 404, referenced-record/uniqueness
conflicts 409, missing authentication 401, and database failures 500.

## Public feeds — frontend compatibility

Unchanged URLs: `GET /resume/:category` and `GET /resume/:category.json`.
Legacy `GET /resume_data/:category.json` also reads the database.

Each returns the original wrapper/record shape above, **published entries only**,
ordered by `sort_order`, then permanent ID. All imported entries start published.
Legacy records without an `id` field keep their original public shape; their
permanent ID is exposed by management APIs. Workshop IDs already present in the
JSON are preserved exactly. New entries include their permanent `id` in the feed.

The existing `GET /speaker/speaker_menu` and `/speaker/speaker_menu.json`, plus
`GET /speaker_data/speaker_menu.json`, return `{title, subtitle, categories:[...]}`.
Only published categories and their published topics are included.

Database errors do not silently fall back to JSON. Existing media URLs are unchanged.

## Résumé management — all ten categories

- `GET /api/resume/categories`: categories, their public wrapper keys, and editable
  content fields/types. This lets the website avoid exposing metadata as content fields.
- `GET /api/resume/:category`: all entries, including drafts.
- `GET /api/resume/:category/:id`: entry detail.
- `POST /api/resume/:category`: create.
- `PUT` or `PATCH /api/resume/:category/:id`: partial update.
- `DELETE /api/resume/:category/:id`: explicit deletion.

Create/update body:

```json
{
  "entry": {
    "label": "Guest Speaker at Example Toastmasters",
    "type": "speech",
    "desc": "<p>Public description.</p>",
    "details": {
      "date": "October 26, 2026",
      "club": "Example Toastmasters",
      "location": "Example Library"
    },
    "gallery": [],
    "link": "https://example.com/video"
  },
  "published": false,
  "sort_order": 0,
  "organization_id": null
}
```

Management responses:

```json
{
  "success": true,
  "data": {
    "id": "permanent-string-id",
    "published": false,
    "sort_order": 0,
    "organization_id": null,
    "created_at": "...",
    "updated_at": "...",
    "entry": { "id": "permanent-string-id", "label": "..." }
  }
}
```

Rules:
- New IDs default to stored random UUIDs, never titles or array indexes. A client
  may supply `entry.id` on create. IDs cannot be changed by editing/reordering.
- `entry` is required on create. `label` is required for most categories;
  awards/certificates require `title`, testimonials require `name`.
- New entries default to **draft**, with `sort_order: 0` and no organization link.
- Omitted fields remain unchanged on PUT and PATCH. Supplied `entry` fields merge
  at the top level. Nested `details`, `gallery`, and `sessions` **replace as a whole**.
  To preserve other detail keys, send the full edited details object.
- Content fields accept null where appropriate; IDs and publishing/order metadata
  cannot be null. Null `organization_id` unlinks the public entry.
- Unknown fields and invalid types are rejected before writing.
- Workshop public sessions use `entry.sessions` objects with `time` (HH:MM),
  `timeZone`, `durationMinutes`, and `attendees`; integer counts must be non-negative.
  Updating this array atomically replaces the public session breakdown.
- Existing `totalAttendance` is a curated public field. If changing the session
  breakdown, update it in the same request where applicable. It is never derived
  from private CRM records and is not necessarily a unique-person count.
- Deleting a résumé workshop referenced by CRM returns 409. Unlink deliberately
  first, or set `published: false` to hide it while retaining history.
- Private notes, fees, activity, and contact details are never included in public feeds.

## Organizations, events, contacts

Both `/api/organizations` and `/api/events` support:
- `GET` collection, `GET /:id`, `POST` collection, `PUT/PATCH /:id`, `DELETE /:id`.
- Updates are partial; omitted fields remain unchanged. Nullable fields accept null.
- Referenced records cannot be deleted silently; FK conflicts return 409.

Organization fields: `name` (required, unique exact text), `website`, `notes`.
Event fields: `name` (required), `organization_id`, `event_date` (YYYY-MM-DD),
`venue_name`, `venue_address`, `notes`.
`GET /api/events?organization_id=42` filters by organization.

Organization-contact links:
- `GET /api/organizations/:id/contacts`.
- `POST /api/organizations/:id/contacts`, body `{ "contact_id": 7 }`.
- `DELETE /api/organizations/:id/contacts/:contact_id`.

## Existing workshops — extended, not replaced

Existing list/detail/create/PUT/PATCH/DELETE and status URLs remain:
`/api/workshops`, `/api/workshops/:id`, `PATCH /api/workshops/:id/status`.

Additional response/create/update fields: `organization_id`, `event_id`.
Existing fields, fee compatibility, `resume_entry_id`, and response envelopes remain.
Collection filters: `status`, `organization_id`, `event_id`, `resume_entry_id`.

Many-to-many résumé linking is now available. See
[workshop-many-to-many-links.md](workshop-many-to-many-links.md) for the complete
frontend contract. Workshop responses include read-only `resume_entry_ids`.
Use GET/POST `/api/workshops/:id/resume-entries` and DELETE
`/api/workshops/:id/resume-entries/:resume_entry_id` to manage individual links.
The `resume_entry_id` list filter searches both legacy and additional links.
The single legacy field below remains compatible, but represents only its own
slot, not the complete set of links.

New clients should use `organization_id`. Older clients may keep sending
`organization_name`: an exact-name organization is linked or created automatically.
If sending both, the name must match the ID. The returned `organization_name`
is kept in sync with an organization rename for old clients.
A workshop must belong to an organization; null `organization_id` with an
existing name resolves that name rather than removing the organization relationship.

`event_id` and `resume_entry_id`: omitted = unchanged; null = unlink.
`resume_entry_id` must be an existing database résumé workshop ID, draft or
published. Validation rejects the whole request before modifying other fields.
A real FK also prevents concurrent deletion from leaving a dangling reference.

**All four statuses are editable:** Active, In Progress, Complete, Inactive.
Legacy input `Completed` is still normalized to `Complete`. Complete is no longer
a lock: notes, contacts, fees, sessions, links, and status can be corrected.
Changing status does not change publication or public content.

Deletion of a workshop with session/activity children returns 409 rather than
silently deleting that history. Prefer Inactive when preserving records matters.

## Sessions, activity, and change history

CRM session endpoints:
- `GET/POST /api/workshops/:id/sessions`.
- `PUT/PATCH/DELETE /api/workshops/:id/sessions/:session_id`.

Fields: `starts_at` (ISO timestamp with Z or offset), `time_zone` (IANA zone,
defaults to America/New_York), `duration_minutes`, `attendees`, `venue_name`,
`venue_address`, `notes`. Numeric counts must be non-negative integers.
Omitted update fields remain unchanged; nullable fields accept null.
Sessions cannot be edited through a different parent workshop URL.

Activity:
- `GET/POST /api/workshops/:id/activity-logs`.
- Create body: required `log_text`, optional `contact_id`, optional `log_date`
  (ISO timestamp with an offset). Both old entity fields and direct workshop FK
  are filled automatically.
- Existing `/api/activity-logs` list/detail/POST/PUT/PATCH/DELETE remain available.
  Legacy `{entity_type:"workshop",entity_id:42,...}` writes fill `workshop_id`
  through a database trigger. New workshop activity cannot reference a missing workshop.
- Activity entries are editable/deletable through the existing activity endpoints.
  They record interactions; entering text does not implicitly change a workshop's
  status or fee. Use the workshop update API for field edits.

Automatic change history is separate from manual activity:
- `GET /api/workshops/:id/history`: workshop, session, linked-contact, and activity
  changes, newest first.
- `GET /api/portfolio/history?resource_type=resume_speeches&resource_id=...`:
  history for an individual resource. `resource_type` uses its table name from
  the mappings above, or the CRM/speaker tables.
- Rows include `operation`, `before_data`, `after_data`, `changed_at`,
  `resource_type`, `resource_id`, and optional `workshop_id`.
- History is written by database triggers in the same transaction as the change.
  It is read-only through the API and retained after explicit record deletion.
  It records what changed and when; existing shared CRM authentication does not
  provide a distinct person identity for actor attribution.
- Prior activity history is preserved. Field-by-field history starts with this
  migration; earlier before/after values cannot be reconstructed.

## Speaker menu management

- `GET /api/speaker-menu`: title/subtitle plus all category/topic metadata/content.
- `PATCH /api/speaker-menu`: partial `title`, `subtitle`.
- `POST /api/speaker-menu/categories` and `POST /api/speaker-menu/topics`.
- `PUT/PATCH/DELETE /api/speaker-menu/categories/:id`.
- `PUT/PATCH/DELETE /api/speaker-menu/topics/:id`.

Create: `id`, `content` (object containing `title`), optional `published`
(defaults false) and `sort_order` (defaults 0). Topics also require `category_id`.
IDs are permanent. Category `items` are managed through topic records, not embedded
in category content. Topic `content` holds the original `title`, `type`,
`description`, and optional `parts` fields. Partial content edits retain omitted
content keys. Delete topics before deleting their category, or unpublish it.

## Verification

`npm test` includes isolated PostgreSQL migration/API tests using a temporary
schema within a rolled-back transaction. It does not alter application records.
Coverage includes lossless import, failed-import rollback, import idempotency,
every feed alias, every category's CRUD, publication, permanent IDs, completed
workshop corrections, organizations, event/session relationships, old-client
compatibility, real FK constraints, activity/history, nullable résumé links,
authentication, and speaker-menu management.

The separate Who Call Paul frontend still needs management screens wired to
these APIs. Existing public display URLs need no structural rewrite.
