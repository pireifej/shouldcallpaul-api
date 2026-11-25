---
name: Private Holiday Greetings boundaries
description: Owner-only private contacts/drafts, separate from CRM identity and manual native Messages workflow.
---

Holiday Greetings is a private, single-owner feature, separate from public
portfolio data, CRM contacts, and Pray Over Us accounts. The existing website's
client-side GUI gate and shared proxy credentials are never owner authorization.
Use the verified Google subject as ownership and keep contacts read-only.

**Why:** The website proxy already has service credentials, but that must not
expose a private address book or personal greeting drafts to other callers.

**How to apply:** Preserve separate durable owner sessions and encrypted provider
authorization. Keep the browser on the frontend's same origin through a
cookie-aware, nonlogging OAuth proxy; do not rely on cross-domain cookies.

SMS greeting sends are always manual, one recipient at a time, through the owner's
existing native Messages app. No cloud SMS, group sending or background sending.
Opening a composition link is not proof that Messages opened, Send was pressed,
or delivery occurred. Only explicit owner confirmation marks a draft sent.

**Why:** The browser cannot observe native sending, and the owner specifically
wants to review and press Send personally.

**How to apply:** Save drafts, selected numbers and queue position durably before
handoff; retain separate handoff/sent/skipped states and optimistic conflicts.
Do not infer beliefs or relationships, auto-select contacts, or guess country
codes when creating greetings.

Email greetings may use Gmail send-only authorization for the server-verified
owner, with one explicit reviewed recipient per send. Do not request mailbox
reading/management, infer sender identity from the caller, or send in bulk.
Persist send-attempt evidence before contacting Gmail. An unknown outcome must
not cause an automatic resend, and Gmail acceptance is not proof of delivery.

**Why:** The owner expanded the feature to individual Gmail sends while
explicitly retaining manual review, private Contacts-only preferences, and the
existing native SMS workflow.

**How to apply:** Require additional Gmail consent for older connections
without disabling their SMS access. Preserve old drafts and stable owner/contact
identities, and keep the Who Call Paul same-origin callback unchanged. Use
mocked providers unless the owner explicitly authorizes a real send.
