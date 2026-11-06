# CRM workshop engagement dates

Backend-only extension. A CRM workshop can have many distinct calendar dates
without duplicating its notes, contacts, resources, sessions, activity or résumé
links. Available in every status, including Complete.

## Authentication and response conventions

Use the same authentication as the existing private `/api/workshops` API.
Success responses are HTTP 200 with `{ "success": true, "data": ... }`.
Failures are `{ "success": false, "error": "..." }`.
No engagement dates or internal compatibility flags are added to public résumé
feeds. Date operations do not publish résumé entries or change résumé counts.

## Endpoints

| Method | Path | Result in `data` |
| --- | --- | --- |
| GET | `/api/workshops/:id/engagement-dates` | Chronologically sorted date records; `[]` if none |
| POST | `/api/workshops/:id/engagement-dates` | Created date record |
| PUT or PATCH | `/api/workshops/:id/engagement-dates/:date_id` | Updated date record, retaining its ID |
| DELETE | `/api/workshops/:id/engagement-dates/:date_id` | `{ "deleted_id": "..." }` |

POST, PUT and PATCH accept exactly:

```json
{ "engagement_date": "2026-11-06" }
```

Example create or update response:

```json
{
  "success": true,
  "data": {
    "id": "6c5695f0-afab-4782-99f5-bff2c12566ac",
    "workshop_id": 42,
    "engagement_date": "2026-11-06"
  }
}
```

IDs are server-generated UUID strings stored permanently in the database.
Do not derive them from dates, array positions or titles. They stay unchanged
when a date is edited.

`engagement_date` is a real Gregorian calendar date in exact `YYYY-MM-DD`
format, years 0001–9999. Timestamps, timezone offsets, null, blank, impossible
dates and unknown fields are rejected with 400. Duplicate dates in the same
workshop return 409, including update conflicts, without saving any change.
The same date on different workshops is allowed.

Unknown workshop: 404. Updating/deleting a date outside the workshop specified
in the URL: 404, even if the date exists elsewhere. Authentication failure uses
the existing authentication middleware. Missing schema before Publish: 503.
Operations are transactional and serialized using a parent-workshop row lock.

## Workshop list and detail

`GET /api/workshops` and `GET /api/workshops/:id` include the collection
directly; calendar screens do not need a separate HTTP request for each workshop.
Create, update and status-change responses include it too.

```json
{
  "success": true,
  "data": {
    "id": 42,
    "status": "Complete",
    "historical_date": "2026-10-07T00:00:00.000Z",
    "engagement_dates": [
      {
        "id": "6c5695f0-afab-4782-99f5-bff2c12566ac",
        "workshop_id": 42,
        "engagement_date": "2026-10-07"
      },
      {
        "id": "87b17fe5-ac77-4d05-abde-e32aa18f1a73",
        "workshop_id": 42,
        "engagement_date": "2026-11-06"
      }
    ]
  }
}
```

The list endpoint still returns an array in `data`, with the same other fields
and existing filters. Dates are ascending; there is no manual date ordering.
Refetch the workshop or date list after changes. `engagement_dates` is read-only
on workshop create/update; use the child endpoints to modify it.

Use the date strings directly as calendar dates. Do not parse them as UTC instants
and then format in the browser's timezone, which could shift the day.

## Legacy `historical_date` compatibility

The existing timestamp column and response representation remain available.
It is a designated **legacy slot**, not necessarily the earliest date.

* Existing nonempty values are represented by one child row marked internally
  as legacy-owned. Its calendar date is obtained by a PostgreSQL `::date` cast
  from the existing **timestamp without time zone**, not a JavaScript conversion.
  The original timestamp is not rewritten during backfill.
* Omitting `historical_date` on a workshop PUT/PATCH preserves all dates.
* Setting it changes only the legacy slot. If the destination date is not already
  present, editing that legacy-only row retains its ID.
* Null or the old GUI's empty string clears only the legacy slot.
* Additional dates created through the new endpoints are independently owned.
  A legacy set or clear never removes them, even if an old GUI temporarily
  selects the same date as its single value.
* When a legacy value overlaps an additional date, there is still only one
  visible child row, retaining the additional row's ID. Changing/clearing the
  legacy slot leaves that additional date intact. A replaced legacy-only row
  disappears if merged into an already-existing additional row.
* Editing a child that currently represents the legacy slot updates
  `historical_date` to the edited calendar date at midnight. Explicitly deleting
  that child clears `historical_date`; it does not automatically select another
  date. Editing/deleting other children leaves the legacy field unchanged.
* Creating a new child does not automatically set the legacy field. New
  frontends must use `engagement_dates` for calendars, not the old single field.

Workshop create/update accepts `historical_date` as date-only or an ISO midnight
representation such as `2026-10-07T00:00:00.000Z`; it preserves the written date.
Non-midnight timestamps, nonzero timezone offsets and invalid dates are rejected
instead of guessing. Other fields in an invalid request are not saved.

## Migration and publishing

Schema source: `migrations/workshop-engagement-dates.sql`. It adds only
`crm_workshop_engagement_dates`, its uniqueness constraints/index, and a foreign
key to CRM workshops. No existing columns or rows are dropped or renamed.
Deleting an entire CRM workshop cascades its date rows, subject to existing
workshop deletion restrictions.

Development preparation (`node scripts/prepare-portfolio-development.js`)
creates the table and performs an idempotent data backfill in development.
**It must not run against production or in deployment build/start commands.**

Publish applies the additive schema diff to production. Do **not** select
“overwrite production data with development data.” The application never creates
this schema at startup. After Publish, the first authenticated workshop-list
request backfills existing dates with data-only inserts in a transaction. Reading
an individual workshop or using a child endpoint backfills that workshop first.
Thus the new frontend's normal initial workshop fetch completes the production
backfill; no separate migration endpoint or production DDL script is needed.
Repeated reads preserve IDs and do not insert duplicates.

An unmigratable legacy date (for example infinity or a year outside 0001–9999)
returns 409 naming the affected workshop and original value, rolling the
transaction back; it is not silently skipped. Until the schema is published,
old workshop operations continue working with their old response shape (no
`engagement_dates` field); new child endpoints explicitly return 503. Do not treat
an absent field as an empty migrated collection.

Production preflight found 20 non-null legacy dates, all ordinary midnight
timestamps in the supported range. No production date backfill is performed by
development testing.
