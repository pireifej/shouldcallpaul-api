# Automatically maintained delivered-workshop catalog

## Scope and rollout

The existing speaker tables remain the catalog. Completed public résumé
workshops provide evidence that a topic has been delivered. CRM workshops,
contacts, fees, resources, notes, and activity logs are never catalog inputs.
Neither source is combined into a new event/tally count.

This is a backend-only implementation. There are no workshop editor forms in
this repository. The separate Who Call Paul frontend must implement the inline
selector/create controls using the API below. Existing public website consumers
keep the same URLs and JSON structure.

1. Development schema: `node scripts/prepare-portfolio-development.js`.
2. Review the additive Publish schema diff, then publish manually.
3. After Publish installs the schema, startup performs a **one-time,
   transactional, data-only** baseline reconciliation. No production DDL,
   deployment build migration, dev-to-production data copy, or recurring
   refresh job is used.

Until the new schema exists, the new catalog reads/writes return 503 with a
schema-pending message. The old published application is unchanged until you
publish. No production content was changed while implementing this feature.

### Additive storage

- `resume_workshops.completion_status`: `draft` (default), `scheduled`,
  `complete`, `cancelled`. This is **public-history metadata**, not CRM status.
- `resume_workshops.catalog_topics_explicit`: protects explicit selections,
  including intentionally empty selections, from automatic rematching.
- `speaker_workshop_topics`: workshop/topic composite primary key, FKs,
  `source` (`explicit` or `automatic`). Many topics per delivery and many
  deliveries per topic.
- `speaker_topic_aliases`: internal normalized title aliases.
- `speaker_title_mappings`: remembered explicit decisions, including
  intentional multi-topic sets. Internal only.
- Speaker topic metadata: `catalog_hidden`, `archived`, unique nullable
  `catalog_title_key`. Stable topic IDs are preserved.

Completion is **not inferred from dates**, CRM status, or publication alone.
The verified existing completed-public-history baseline is marked complete by
permanent IDs, once. Imported records from the old completed-workshop feed are
also verified completed records. New API records default to `draft` even when
`published:true`. A scheduled/future event should stay `scheduled` until the
presenter confirms it was delivered; setting `complete` is that explicit
confirmation.

## Public APIs, unchanged shapes

All three return the same catalog:

- `GET /speaker/speaker_menu`
- `GET /speaker/speaker_menu.json`
- `GET /speaker_data/speaker_menu.json`

```json
{
  "title": "…",
  "subtitle": "…",
  "categories": [{
    "id": "ai_technology",
    "title": "AI & Technology Literacy Workshops",
    "items": [{
      "id": "ai_career_search",
      "type": "workshop",
      "title": "AI & the Modern Career",
      "description": "Understand AI-assisted hiring and use Gemini and NotebookLM to organize your career experience, tailor applications without inventing qualifications, and discover relevant job opportunities."
    }]
  }]
}
```

An item may also contain `parts`, as before. Internal aliases, mappings,
publication flags, delivery IDs, and all CRM details are excluded.

Eligibility requires:

- Published category.
- Published topic with `catalog_hidden:false` and `archived:false`.
- At least one linked résumé workshop with `published:true` and
  `completion_status:"complete"`.

Each topic appears once via an `EXISTS` query, in configured `sort_order,id`
order. Categories retain their configured order; empty categories are omitted.
Removing/unpublishing/cancelling/correcting the last eligible delivery removes
eligibility without deleting the topic.

**Caching:** these endpoints execute fresh SELECT queries and send
`Cache-Control: no-store`. There is no backend catalog cache to invalidate.
GETs never create topics/links, change publication, reconcile records, or call
an LLM. The public website's separate five-minute cache is **unchanged**. It
may delay visible updates until expiry; immediate frontend invalidation must
be implemented in that other project.

## Authenticated workshop save APIs

Existing CRM authentication applies to every management endpoint.

Use the existing APIs:

- `POST /api/resume/workshops`
- `PUT /api/resume/workshops/:id`
- `PATCH /api/resume/workshops/:id`
- `GET /api/resume/workshops` and `GET /api/resume/workshops/:id`
- `DELETE /api/resume/workshops/:id`

The existing `{entry,published,sort_order,organization_id}` envelope is
preserved and gains **top-level** `completion_status` and `catalog` inputs.
Do not put these inside `entry`, whose public field allowlist is unchanged.

### Choose one or multiple existing offerings

```json
{
  "entry": {"label": "A delivery title at a specific event"},
  "published": true,
  "completion_status": "complete",
  "catalog": {
    "topic_ids": ["find_your_voice", "think_on_your_feet"],
    "remember_title": true
  }
}
```

`catalog.topic_ids` is a replacement selection, not an append. Unknown IDs
reject the entire transaction. `[]` intentionally excludes the workshop from
topic matching and remains empty on later ordinary saves.
Omitted `catalog` preserves explicit selections. For automatically linked
records, an edited title is safely rematched, removing stale automatic links.
Omitted completion status is unchanged on updates.

`remember_title` defaults to true. It records this exact normalized delivery
title's chosen topic set for later records. Set false for a one-off decision.
Explicit topic IDs take priority; no fuzzy or AI matching occurs.

### Create a new reusable topic in the same save

```json
{
  "entry": {"label": "AI training for an event"},
  "published": true,
  "completion_status": "complete",
  "catalog": {
    "topic_ids": [],
    "new_topics": [{
      "title": "Practical AI and Document Skills",
      "description": "Build confidence using AI responsibly alongside everyday document tools.",
      "category_id": "ai_technology",
      "type": "workshop",
      "public_copy_confirmed": true
    }]
  }
}
```

New topics receive server UUIDs, a permanent canonical title key, publication
enabled, and a last-in-category sort order. They are not visible unless their
delivery is public and complete and their category is published.
Matching an existing title/alias reuses its ID **without** overwriting its
copy or clearing its publication, archive, or hide override. An ambiguous
new-topic title returns 409 with `details` containing the matching candidates.

New topic copy must be explicitly supplied and confirmed client-neutral. The
backend **never** copies an event label/description/details into offering
copy. Title limit 200 characters; description 2,000; plain text only, without
links, email addresses, fees, or ISO event dates. `type` may be `workshop`,
`series`, `program`, or `presentation`; optional `parts` contains up to 50
short strings. This is not an AI copy checker: the editor must honor the
client-neutral confirmation and avoid names, venues, attendance, or dates.

### Response additions

Success remains HTTP 200:

```json
{
  "success": true,
  "data": {
    "id": "permanent-resume-entry-id",
    "published": true,
    "sort_order": 0,
    "organization_id": null,
    "created_at": "…",
    "updated_at": "…",
    "entry": {"id": "permanent-resume-entry-id", "label": "…"},
    "completion_status": "complete",
    "catalog": {
      "completion_status": "complete",
      "topic_ids": ["ai_career_search"],
      "match_state": "linked",
      "suggestion": {
        "state": "matched",
        "source": "exact_or_alias",
        "topic_ids": ["ai_career_search"],
        "candidates": []
      }
    }
  }
}
```

Candidate arrays for exact/alias resolution can contain the matching topic
metadata even when there is exactly one match. `entry` and
`GET /resume/workshops` do not gain management-only catalog fields.

## Editor suggestions and review

- `GET /api/speaker-menu/catalog-suggestions?title=<URL-encoded title>`
  returns `{success:true,data:{state,source?,topic_ids,candidates}}`.
  `state` is `matched`, `ambiguous`, or `unmatched`. Candidates contain stable
  IDs, titles, category IDs, and hide/archive flags.
- `GET /api/speaker-menu/catalog-review`
  returns `{success:true,data:{linked:[...],needs_review:[...]}}`.
  Each record includes ID, event label, publication/completion metadata, and
  catalog matching metadata. Intentionally empty selections also appear in
  `needs_review`; never change them without an explicit editor decision.
- `GET /api/speaker-menu` remains the full administrative catalog, including
  hidden, archived, and presently ineligible topics, for the selector.

Frontend flow: prefill an exact/remembered suggestion; for ambiguous results,
ask the user to choose an existing offering or create a distinct one. Collect
reusable title, short description, and category alongside the workshop's save
form. Send the chosen `catalog` and completion status in **one** request.
An unmatched/ambiguous workshop can still be saved without a catalog decision,
preserving historical data, but it cannot make an unlinked offering eligible.

Matching order is explicit selection, remembered title set, then aliases or
normalized exact titles. Normalization only changes case, Unicode
compatibility, apostrophes, ampersand/“and”, whitespace and punctuation. It
does not strip venues/clients, tokenize by broad category, or use similarity.

## Topic management and manual overrides

Existing `/api/speaker-menu/topics/:id` PUT/PATCH accepts:

```json
{"catalog_hidden": true}
```

This is the clear “Hide from catalog” override. Unhiding requires explicitly
sending false; reconciliation never unhides or republishes an existing topic.
`{"archived":true}` and `{"published":false}` independently exclude it.

Existing topic POST/PUT/PATCH also accept `aliases:["Former or alternate title"]`.
Renaming preserves its former title internally. Dedicated topic-editor saves
are already explicit public-copy input; `public_copy_confirmed` is optional
there, but mandatory for `catalog.new_topics`.
Published new/edited topics require a title and reusable description. Existing
stable IDs, category/order fields, and content response structure are retained.
Deleting a linked topic returns 409; archive/hide it instead.

## Transactions and imports

Workshop saves, inline topic creation, remembered mappings, and reconciliation
share one transaction. A shared advisory transaction lock serializes catalog
writers; database primary/unique/FK constraints protect identity and links.
Repeated updates and imports do not duplicate links or topics. Explicit IDs
make a retried create conflict instead of creating a second delivery.

Application imports must use `saveEntry` inside `transaction`, with
`{imported:true}` **only for verified completed-public-history imports**.
Ordinary creates must not pass that option. If an importer takes parent locks
before calling the store, acquire `catalog.lock(db)` first, just like the API,
to preserve lock ordering. Direct SQL bypassing the application is not a
supported upkeep path.

## Initial cleanup and historical review

See `speaker-catalog-initial-review.md`. Cleanup is idempotently marked in
`portfolio_migrations` and does not run again over later manual edits.
No historical workshops, CRM records, topics, or logs are deleted.
