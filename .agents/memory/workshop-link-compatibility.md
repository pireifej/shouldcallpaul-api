---
name: Workshop link compatibility
description: Why many-to-many workshop links retain the legacy single slot instead of destructively migrating it.
---

Keep the legacy single-link slot separate from additional links, exposing their
deduplicated union. Do not blindly backfill that slot into the additional-link
table or make old clients replace the whole set.

**Why:** Older clients clear or replace only their single slot. Copying it into a
junction would make those old unlink operations appear successful while leaving
the copied link active. An additive relationship also avoids a production data
backfill during a schema-only Publish.

**How to apply:** New clients add/remove individual links. Explicitly removing a
specific ID must clear it from either storage location. Old-client writes must
never erase links added by new clients.
