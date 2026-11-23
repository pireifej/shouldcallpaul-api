---
name: Prayer Walk access
description: Prayer Walk's Pro boundary supersedes its earlier temporary free exception.
---

Prayer Walk audio requires Pro, with app authentication and a verified user
session. Extended prayer generation also remains Pro-only.

**Why:** The user explicitly requested restoring the Pro boundary as part of the
subscription-audit fixes, overriding the earlier temporary free access.

**How to apply:** Enforce the same check on legacy and stream aliases before
serving memory/disk cached audio. Do not reintroduce free access just because
the mobile purchase flow is unfinished.