---
name: RevenueCat Pro identity policy
description: Durable rules for subscriber identity linking and premium authorization.
---

RevenueCat is the source of truth for Pray Over Us Pro. Never persist a local entitlement flag or grant premium access from a client-provided boolean.

Only save a RevenueCat App User ID after RevenueCat confirms that it has the active Pro entitlement. A linked identity must be unique across application users and must not silently replace a different existing mapping. If historical duplicate ownership is ambiguous, clear every duplicate mapping and require re-verification rather than guessing an owner.

All routes that expose the same premium resource must enforce the same entitlement rule, including legacy route names. Apply the temporary free-access exceptions in daily-bread-access.md and prayer-walk-access.md rather than assuming every devotional or audio route is premium.

**Why:** RevenueCat customers currently use anonymous App User IDs, so backend identity cannot be inferred from the numeric application user ID. Inconsistent legacy guards or overwriteable mappings would allow premium bypasses.

**How to apply:** Reuse the shared entitlement service and Pro middleware for new premium routes. Treat provider failures explicitly, keep caches short and bounded, and preserve standard/free content when a premium check fails without leaking premium content.