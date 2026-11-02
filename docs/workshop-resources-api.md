# Private CRM workshop resources — frontend integration

Resources are custom shortcut buttons such as Notes, Outline, PowerPoint or
Handouts. They store URLs only, belong to a **CRM workshop**, and are shared by
all résumé presentations linked to that CRM workshop. They do not belong to or
appear in public résumé entries. No uploads or Google Drive connection are used.

Use the existing CRM authentication. Keep shared backend credentials server-side.
No frontend work is implemented in this backend project.

## Resource object

```json
{
  "id": "df009ae9-c81f-4b81-a79b-0436777dc0cf",
  "workshop_id": 42,
  "label": "Notes",
  "url": "https://docs.example.com/my-notes",
  "sort_order": 0,
  "created_at": "2026-11-02T15:00:00.000Z",
  "updated_at": "2026-11-02T15:00:00.000Z"
}
```

`id` is a server-generated, permanent UUID string. `workshop_id` comes from the
URL and cannot be overridden by a body. Timestamps are server-managed.

## Endpoints and envelopes

All URLs below use the integer CRM workshop ID, not a résumé entry ID.

| Method | Path | Body | `data` on success |
|---|---|---|---|
| GET | `/api/workshops/:id/resources` | none | Ordered resource array, or `[]` |
| POST | `/api/workshops/:id/resources` | `{label,url,sort_order?}` | Created resource object |
| PATCH | `/api/workshops/:id/resources/:resource_id` | Any of `{label,url,sort_order}` | Updated resource object |
| PUT | `/api/workshops/:id/resources/:resource_id` | Same partial-update semantics as PATCH | Updated resource object |
| DELETE | `/api/workshops/:id/resources/:resource_id` | none | `{"deleted_id":"..."}` |
| PUT | `/api/workshops/:id/resources/reorder` | `{"resource_ids":["id-first","id-second"]}` | Entire reordered resource array |

All successful operations return HTTP **200**, wrapped as:

```json
{"success": true, "data": []}
```

The `data` value depends on the endpoint as shown in the table. Failed operations
return `{"success":false,"error":"..."}` and do not partially save.

### Create

```http
POST /api/workshops/42/resources
Content-Type: application/json

{"label":"Outline","url":"https://example.com/outline","sort_order":0}
```

Response:

```json
{
  "success": true,
  "data": {
    "id": "bca2a2d2-22e6-46fe-97bc-b8680a9ecdf8",
    "workshop_id": 42,
    "label": "Outline",
    "url": "https://example.com/outline",
    "sort_order": 0,
    "created_at": "2026-11-02T15:00:00.000Z",
    "updated_at": "2026-11-02T15:00:00.000Z"
  }
}
```

### Edit

```http
PATCH /api/workshops/42/resources/bca2a2d2-22e6-46fe-97bc-b8680a9ecdf8
Content-Type: application/json

{"label":"Handouts","url":"https://example.com/handouts.pdf"}
```

Returns the updated resource object in the same success envelope. Omitted fields
remain unchanged. `null` does not clear required fields; it is rejected.

### Reorder

```http
PUT /api/workshops/42/resources/reorder
Content-Type: application/json

{"resource_ids":["bca2a2d2-22e6-46fe-97bc-b8680a9ecdf8","df009ae9-c81f-4b81-a79b-0436777dc0cf"]}
```

Returns `data: [{...first resource, sort_order:0}, {...second resource, sort_order:1}]`.
Send the **entire current list** of IDs, each exactly once. It must contain only
resources belonging to this workshop. An incomplete/stale/foreign list returns
409; refresh the list and retry. Duplicate/malformed IDs return 400.
`{"resource_ids":[]}` is valid only when this workshop has no resources.

### Delete

```http
DELETE /api/workshops/42/resources/bca2a2d2-22e6-46fe-97bc-b8680a9ecdf8
```

```json
{"success":true,"data":{"deleted_id":"bca2a2d2-22e6-46fe-97bc-b8680a9ecdf8"}}
```

## Ordering rules

- `sort_order` is **zero-based and contiguous**: 0, 1, 2, …
- GET always returns display order (`sort_order`, then ID for deterministic ties).
- Create without `sort_order` appends. With `sort_order`, inserts at that position,
  shifting following resources; accepted positions are 0 through current count.
- Update without `sort_order` retains position. With `sort_order`, moves the item
  and shifts others; accepted positions are 0 through current count minus one.
- Delete compacts remaining positions; no gap is left.
- Reorder applies the full sequence atomically. Repeating the same reorder has
  no effect on resource timestamps.
- IDs never change when labels, URLs, or order change.
- Resource operations lock the CRM parent row to serialize concurrent ordering
  changes. Resource timestamps can change; parent workshop timestamps do not.
- Refetch the collection after create/move/delete to get all shifted positions,
  or use the full array returned by reorder.

## Validation, privacy and errors

- Labels are trimmed, must be nonempty text, maximum 200 characters.
- URLs are trimmed, must be absolute HTTP/HTTPS with a hostname, maximum 4096
  characters, with no embedded credentials or unencoded whitespace.
- URLs are not fetched or checked for existence. Private document access is
  still controlled by its hosting provider. Do not put passwords/tokens in URLs.
- Duplicate labels or URLs are allowed; identity is the stable resource ID.
- Render labels as text, not HTML. For buttons opening new tabs, use
  `rel="noopener noreferrer"`.
- Unknown body fields, including `id` and `workshop_id`, are rejected (400).
- Invalid workshop ID is 400; unknown workshop is 404.
- An unknown resource or one belonging to another workshop returns 404 on
  update/delete. Neither the other workshop nor its resources are modified.
- Authentication is required for **every** operation using existing CRM rules.
- Resource changes work in Active, In Progress, Complete and Inactive statuses.
- These endpoints never change workshop notes, contacts, fees, status, activity
  logs, résumé links or public résumé content.
- Workshop list/detail responses remain unchanged; fetch resources separately.
- No public resource feed exists, and no resources are added to `/resume/*`.
- Explicit CRM workshop deletion cascades to its resources; existing
  session/activity protections against workshop deletion remain unchanged.

## Schema and rollout

`migrations/workshop-resources.sql` adds only `crm_workshop_resources`, its
workshop FK, validation constraints and ordering index. There is no data backfill:
existing workshops begin with zero resources. Pray Over Us tables are untouched.

Development-only preparation: `node scripts/prepare-portfolio-development.js`.
Normal Publish applies the additive production schema change. No production
DDL scripts, deployment build migrations or startup DDL are added.

Until that table is available, these new endpoints return an explicit **503**
explaining that Publish is needed; existing workshop APIs continue working.
Schema availability is checked read-only and cached for the server lifetime.
Normal publishing starts a new server; restart after an out-of-band schema change.
