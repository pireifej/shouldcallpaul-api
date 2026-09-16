---
name: Daily Bread access policy
description: Defines which Daily Bread features remain free while in-app purchases are pending.
---

Today’s full Daily Bread devotional content must remain available to every signed-in user without requiring an active Pro entitlement. Premium extras such as generated audio, historical archives, and read/reward actions remain subscription-gated.

**Why:** The devotional is core daily content and must continue to populate and display while the mobile in-app purchase flow is not yet in place.

**How to apply:** Do not add a RevenueCat entitlement check to the current-day devotional content API. Continue requiring normal API authentication and signed user identity, and keep premium extras behind RevenueCat.