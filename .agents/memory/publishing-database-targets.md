---
name: Publishing database targets
description: Secret names do not establish whether a database is covered by Replit's managed Publish schema diff.
---

Do not assume the CRM database is outside managed publishing just because its
connection is named `NEON_DATABASE_URL`. In this project, the managed production
read replica and Publish schema diff exposed the CRM/portfolio tables.

**Why:** Preparing portfolio tables only through the CRM connection left the
managed development schema behind; Publish proposed deleting the populated
production tables to match development. The safe correction was development-only
schema preparation, not approving deletions or recreating production data.

**How to apply:** Confirm the actual managed development/production schemas and
inspect the pending Publish diff after schema changes. Treat connection-variable
names and old dev/prod comments as hints, not proof of database ownership. Never
copy development data over production to resolve a schema mismatch.
