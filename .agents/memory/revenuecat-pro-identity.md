---
name: RevenueCat Pro identity policy
description: Durable rules for subscriber identity linking and premium authorization.
---

RevenueCat is the source of truth for Pray Over Us Pro. Never persist a local entitlement flag or grant premium access from a client-provided boolean.

An active RevenueCat entitlement alone does not prove that the caller owns that
customer. First linking requires an account binding derived from the verified
session, plus authoritative provider confirmation. Client-selected IDs,
editable customer attributes, or client Pro flags cannot establish ownership.
Keep mappings unique and never silently replace an existing mapping. Ambiguous
legacy ownership must fail closed rather than guess an owner.

All routes exposing the same premium resource must enforce the same rule,
including legacy names and cached responses. Apply the current boundaries in
daily-bread-access.md and prayer-walk-access.md, not their former free exceptions.

**Why:** A caller who knows another active customer ID must not be able to claim
its entitlement on first linking. Anonymous legacy mappings are not independently
an account-ownership proof, and inconsistent guards allow premium bypasses.

**How to apply:** Reuse the shared entitlement service and Pro middleware for new premium routes. Treat provider failures explicitly, keep caches short and bounded, and preserve standard/free content when a premium check fails without leaking premium content.