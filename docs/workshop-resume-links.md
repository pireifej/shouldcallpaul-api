# CRM workshop links to completed resume entries

## Ownership and separation

This backend owns `resume_data/workshops.json` and the existing public
`GET /resume/workshops` feed (`GET /resume/workshops.json` is also supported).
Its response remains `{ "records": [...] }`. No duplicate feed or merged tally
is created.

The JSON is the manually maintained completed-workshop resume tally. CRM
workshops remain separate database records with contacts, notes, fees and
activity logs. A link is a reference only, not a copy or synchronization rule.

## Permanent JSON IDs

Every resume workshop record has an opaque, unique string `id`. Existing entries
were assigned UUIDs once and stored in the JSON. Keep each ID unchanged when
editing, renaming or reordering a record. Give each new manual entry a new UUID;
never derive IDs from titles or positions, reuse an ID, or regenerate existing IDs.
Repeated titles can have different IDs.

Do not remove or change an entry's ID while CRM references still depend on it.
There is intentionally no database copy of the JSON and no cross-file SQL
foreign key. If an entry is removed manually, existing references are preserved;
new assignments to its former ID are rejected. Unlinking remains possible.

## Database migration

`migrations/workshop-resume-entry-reference.sql` idempotently adds
`public.crm_workshops.resume_entry_id TEXT NULL`. Existing rows stay unlinked.
No unique constraint is added: multiple CRM workshops can reference one entry.
Startup applies the migration to the existing dev and CRM databases before the
server accepts requests. Required reference-migration failures prevent startup.

## API contract

Existing CRM authentication and response envelopes are unchanged.

| Endpoint | Contract |
| --- | --- |
| `GET /resume/workshops` | Each `records[]` entry includes permanent `id`. |
| `GET /api/workshops?status=...` | Each workshop in `data[]` includes `resume_entry_id`, a string or null. |
| `GET /api/workshops/:id` | Workshop in `data` includes `resume_entry_id`. |
| `POST /api/workshops` | Optional `resume_entry_id`; omission or null creates an unlinked workshop. |
| `PUT /api/workshops/:id` | Partial update: omitted reference stays unchanged; string links/relinks; null unlinks. |
| `PATCH /api/workshops/:id` | Same reference semantics as PUT. |
| `PATCH /api/workshops/:id/status` | Existing status-only behavior; does not touch the reference or JSON. |

Example partial update (replace the UUID with an `id` from the feed):

```json
{ "resume_entry_id": "ad177f44-9344-492a-bb41-a1ccb1a77d26" }
```

Response retains the usual envelope and existing workshop fields:

```json
{
  "success": true,
  "data": {
    "id": 42,
    "status": "Complete",
    "resume_entry_id": "ad177f44-9344-492a-bb41-a1ccb1a77d26"
  }
}
```

To unlink, send `{ "resume_entry_id": null }`.

### Validation and historical protection

- Non-null values must be non-empty strings exactly matching an existing JSON
  `id`. No trimming, title matching or automatic association occurs.
- Invalid values return HTTP 400 with `{ "success": false, "error": "..." }`;
  no requested field is saved, including other fields in the same request.
- Missing CRM records return 404; authentication requirements are unchanged.
- Completed workshops remain read-only **except** for PUT/PATCH bodies containing
  only `resume_entry_id`. This allows historical deliveries to be linked without
  editing their history. Mixing other fields into that body still returns 409.
- Linking/unlinking changes only `resume_entry_id` and the existing `updated_at`
  timestamp. Status, notes, contacts, fees and activity logs are not changed.
- Marking a workshop Complete does not create/edit a JSON record. Neither source
  is deleted or merged by linking, unlinking or completion.
- Older clients can continue omitting this field.
- A missing or malformed JSON catalog fails reference validation explicitly with
  a server error; IDs are never synthesized as a fallback.

## Verification

Run `npm test`. Workshop coverage includes feed shape, permanent IDs, create/
list/detail, PUT/PATCH omission and null semantics, invalid IDs and atomic
rejection, shared targets, historical link-only changes, authentication, missing
records, completion, and byte-for-byte preservation of the JSON during CRM work.
