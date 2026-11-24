---
name: Signed user-session policy
description: Security rules for issuing and consuming Pray Over Us user sessions.
---

User-owned mutations and Pro-gated requests must derive the application user ID from a valid signed user session. Never treat a body-supplied user ID, RevenueCat identity, or shared Basic credential as proof of the end user's identity.

**Why:** The Basic credential identifies the app installation, not an individual. Trusting request fields would allow one client to act as another user or claim another user's subscription access.

**How to apply:** Keep the app-level Basic credential, carry the personal session in the dedicated user-session header, reject any conflicting body user ID, and recheck identity after multipart parsing. Issue sessions only after password verification or provider-token validation, including provider audience checks. Never log session, OAuth, or provider credentials.

For permitted reads of another member's standard history, distinguish the
authenticated viewer from the target member. Do not weaken viewer-session
verification to preserve an older client that uses the viewer field as a target.

**Why:** Member-profile browsing is an intended app feature, but selecting whose
history to display must not establish that person's authenticated identity.

**How to apply:** Keep existing visibility restrictions, permit an explicitly
validated target on supported read routes, and require the frontend to migrate
its target selection rather than accepting an impersonated viewer.