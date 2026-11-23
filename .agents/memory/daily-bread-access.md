---
name: Daily Bread access policy
description: Defines Daily Bread's free preview and Pro reading/audio boundaries.
---

Free users may see the Daily Bread preview. Full devotional readings, all audio
(including archive audio), archives, and read/reward actions require Pro.

**Why:** The user explicitly ended the earlier full-content/audio exception when
requesting subscription-audit fixes. Pending IAP integration is not permission
to restore that exception.

**How to apply:** Preserve the free preview without full text or audio links.
Check verified user identity and the RevenueCat entitlement before returning
full readings or accessing any audio cache, on legacy and current routes alike.