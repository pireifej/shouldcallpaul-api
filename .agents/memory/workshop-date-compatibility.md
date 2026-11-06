---
name: Workshop date compatibility
description: Calendar-date ownership and safe post-Publish backfill for multi-date CRM engagements.
---

Keep calendar dates as date-only strings, and retain separate ownership for the
legacy single date and independently added dates, even when they overlap.

**Why:** The user requires older clients to keep working without silently
erasing additional engagement dates. Selecting an additional date in an old GUI
must not make it disappear on that GUI's subsequent clear or replacement.

**How to apply:** Preserve independently added dates on legacy writes. Explicit
child deletion may remove the specified date and clear its legacy reference.
Backfill production data only after Publish installs the additive schema; never
replace production with development data or invent production startup DDL.
