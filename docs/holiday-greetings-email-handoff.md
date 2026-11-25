# Holiday Greetings: contact setup and individual Gmail extension

## Release status and boundaries

Implemented in backend source only; not published or enabled. All tests use
synthetic contacts, mocked Google services and disposable PostgreSQL. No real
email or SMS was sent. No production data, credentials or configuration changed.
Pray Over Us, CRM and public resume feeds are unchanged.

Verification: **250 tests passed, zero failures and zero skips** across the full
backend suite. Syntax and diff checks passed. The development-only migration was
applied; the pending managed production diff contains five additive statements
(one table, one partial unique index, three foreign keys), with no destructive
operations or warnings.

Prefix for every route below: `/api/holiday-greetings`.
All private routes require the existing verified Holiday owner cookie.
All PUT/PATCH/POST/DELETE requests require the exact frontend Origin and
`X-CSRF-Token` from `/session`. Basic credentials and frontend GUI login do not
grant owner access. Keep the existing cookie-aware, nonlogging same-origin proxy.
Do not expose or log Google/session tokens, private contacts, message bodies,
OAuth parameters or secrets.

Keep the callback exactly:
`https://who-call-paul.replit.app/api/holiday-greetings/oauth/google/callback`.

## Authorization and sender

Continue dedicated owner OAuth, pinned to the verified Google subject and
`HOLIDAY_OWNER_EMAIL`. Configure it for the owner's requested Google account,
not a shared app mailer or another sender. The sender is always that
server-verified account; `from`, CC, BCC and caller-selected senders are rejected.
Gmail sends use `/gmail/v1/users/me/messages/send`, never SMTP/app passwords.

Requested scopes are exactly:
- `openid`
- `email`
- `https://www.googleapis.com/auth/contacts.readonly`
- `https://www.googleapis.com/auth/gmail.send`

No inbox-reading, mailbox-management, contacts-write, bulk or background sender.
Enable Gmail API as well as People API in the dedicated Google Cloud project,
update the OAuth consent configuration, and confirm the approved owner is a
test user if applicable. Google Cloud setup has not been verified or changed.
External Testing refresh tokens can expire after seven days with these scopes.

Existing encrypted Contacts-only authorization remains usable for SMS/contacts.
It is **not** assumed to authorize Gmail. Reconnect via the existing
`GET /oauth/google/start` and callback flow to grant the new scope. Missing Gmail
consent returns HTTP 409 `GOOGLE_GMAIL_CONSENT_REQUIRED` without making a send
attempt. Refreshing a token never invents Gmail permission. Provider tokens and
granted-scope evidence remain encrypted and subject-bound on the backend.

`GET /session` now also returns `gmailSendAuthorized: true|false`. Existing
`authenticated`, `googleConnected`, `csrfToken`, and `expiresAt` remain.
The authorization flag is saved-consent evidence, not a guarantee Google has not
subsequently revoked it; provider failures still require explicit handling.

## Contacts and saved setup

### GET `/contacts?pageSize=50&pageToken=...&search=...`

Same query contract; pageSize is 1–100. Omit pageToken for the first request.
Return `nextPageToken` on every subsequent call until it is null. An empty
filtered page with a nextPageToken is not the end. Search is page-local and
matches name, phone or email. Pagination can review the entire address book.

```json
{
  "contacts": [{
    "resourceName": "people/example-contact",
    "displayName": "Example Friend",
    "givenName": "Example",
    "phoneNumbers": [{"value": "+12025550101", "canonicalNumber": "+12025550101", "label": "mobile"}],
    "hasPhoneNumbers": true,
    "emailAddresses": [{"value": "friend@example.invalid", "label": "home"}],
    "hasEmailAddresses": true
  }],
  "nextPageToken": null,
  "searchAppliesTo": "page"
}
```

### GET `/preferences`; PUT `/preferences`

GET returns `{ "preferences": [...] }` including stable `resourceName`, version
and saved fields. PUT is now a **sparse versioned update**: omitted fields
preserve existing values, preventing new setup controls erasing prior wording.
Create with version 0; subsequent updates use the last returned preference
version. Stale versions return 409 `VERSION_CONFLICT`.

```json
{
  "resourceName": "people/example-contact",
  "version": 0,
  "selected": true,
  "preferredMethod": "email",
  "preferredEmailAddress": "friend@example.invalid",
  "greetingName": "Alex",
  "familyMode": "family",
  "personalNote": "An optional private note",
  "occasions": {"christmas": "opt_in", "easter": "opt_out"}
}
```

HTTP 200 echoes saved fields with version incremented. Existing greetingName,
familyMode/familyCustom, preferredPhoneNumber, personalNote and occasions remain
supported. `occasions`, when supplied, replaces that map; merge it client-side
when editing only one occasion. `selected` must be boolean. `preferredMethod`
is `email` or `sms`; SMS remains the legacy default. For selected contacts,
save the specific current Google email or phone, not just the method. Email
selection is always explicit, even if there is only one email address.

Clear a saved email/phone with null. Deselect with `selected: false`.
Saving or using a destination that disappeared fails with
`CONTACT_EMAIL_CHANGED`, `CONTACT_HAS_NO_EMAIL`, `CONTACT_PHONE_CHANGED`,
`CONTACT_HAS_NO_PHONE`, or `CONTACT_NOT_FOUND`; require review, never substitute.
If a removed old destination prevents saving setup, explicitly clear it while
saving the reviewed replacement or deselection.

No Google Contact or CRM record is modified. Preferences use owner + stable
Google resourceName, not names, email addresses, or list positions as identity.
Unlisted contacts are never auto-selected; old preferences lacking `selected`
are not a saved selection.

## Review queues and drafts

### POST `/batches`

```json
{
  "occasion": "christmas",
  "baseTemplate": "Hello {name}, wishing {family} a happy {occasion}. {note}",
  "recipients": [{
    "resourceName": "people/example-contact",
    "method": "email",
    "emailAddress": "friend@example.invalid",
    "subject": "A holiday greeting",
    "confirmedForOccasion": true
  }]
}
```

HTTP 201 returns the existing batch shape, with `id`, `version`, queuePosition,
occasion/template metadata and `drafts`. Email drafts add:
```json
{
  "id": "<draft-uuid>",
  "position": 0,
  "resourceName": "people/example-contact",
  "displayName": "Example Friend",
  "method": "email",
  "emailAddress": "friend@example.invalid",
  "subject": "A holiday greeting",
  "message": "<expanded editable text>",
  "state": "draft"
}
```

There must still be 1–200 unique, explicitly supplied recipients. The frontend
builds this array only from reviewed selections; there is no select-all-contacts
server default. Explicit legacy recipient arrays remain valid selections for
backward compatibility, but `selected:false` in saved preferences rejects
inclusion. Method/destination default to saved preferences when omitted.
`method` defaults to SMS for legacy recipients. `message` may override the
template for an individual recipient. Email `subject` is required.
Occasion opt-outs always reject; ask/default requires confirmedForOccasion.
Batch creation saves drafts only and **never sends** anything.

Existing SMS drafts without `method` continue to mean SMS. No old draft is
rewritten or reclassified by migration.

### PATCH `/batches/:batchId/drafts/:draftId`

Use current **batch** version:
```json
{
  "version": 3,
  "emailAddress": "friend@example.invalid",
  "subject": "My revised subject",
  "message": "My final reviewed greeting.",
  "state": "draft",
  "queuePosition": 0
}
```

HTTP 200 returns the updated batch with incremented version. Allowed edit
states remain `draft` and `skipped`. Omitted fields stay unchanged. The chosen
address must still belong to that Google Contact. Method is fixed for a draft;
email fields on SMS drafts and SMS-only actions on email drafts are rejected.
Skipping never sends anything.

Existing batch GET, current-batch GET, queue-position PATCH and template editing
remain. Resume using `/batches/current` or `/batches/:batchId` after reload.
Use existing `/opened` then explicit `/mark-sent` for SMS only. Their states
`opened_in_messages` and `manually_marked_sent` do not claim observed delivery.

## Explicit individual email send

### POST `/batches/:batchId/drafts/:draftId/send-email`

Only invoke when the owner clicks **Send email** for that specific reviewed
draft. Save edits first, then use the resulting batch version.

```json
{
  "version": 4,
  "attemptId": "<new-client-generated-uuid>",
  "confirmed": true
}
```

This endpoint accepts **only** those fields; recipient, subject and body come
from the persisted version-checked draft. The server revalidates the current
contact destination, occasion exclusions/selection, owner session, connected
owner and Gmail consent. Shared route middleware checks Origin and CSRF.
The MIME message has exactly one To address, a fixed verified sender, and no
CC/BCC. Header injection and empty/invalid subject/body are rejected.

Before contacting Gmail, a durable attempt is committed and the draft becomes
`email_sending`, incrementing the batch version. A row lock and partial unique
index prevent concurrent sending for that draft, including different attempt
IDs or requests on different server instances.

Successful HTTP 200:
```json
{
  "attempt": {
    "id": "<same-attempt-uuid>",
    "state": "accepted",
    "acceptedByGmail": true,
    "deliveryConfirmed": false,
    "requiresReview": false
  },
  "replay": false
}
```

Refetch the batch for its latest version and `email_accepted` draft state.
Gmail acceptance means Gmail accepted the request, **not delivery**.

| Attempt state | HTTP | Draft state | Frontend behavior |
| --- | ---: | --- | --- |
| accepted | 200 | email_accepted | Show accepted by Gmail, not delivered |
| sending | 202 on replay | email_sending | May be in flight or interrupted; disable send, inspect status |
| rejected | 409 | email_rejected | Gmail definitively rejected; review before any new attempt |
| unknown | 409 | email_outcome_unknown | Gmail may have accepted; do not resend automatically |

Same attemptId replays its recorded outcome without another send, including
when the submitted version is now old. Reusing it for another batch/draft
returns 409 `SEND_ATTEMPT_CONFLICT`. Concurrent different IDs fail version or
send-state checks. A definite rejection can be explicitly edited back to draft
and retried with a new ID, only following a new Send email click.

Unknown/sending/accepted drafts cannot be reset or edited to permit another send.
No timeout unlock, automatic retry, background worker or reconciliation resend
exists. A crash after claiming but before sending is deliberately conservative:
it leaves sending state and requires human investigation. If Gmail accepted
but saving the result failed, HTTP 409 `EMAIL_OUTCOME_UNKNOWN` is returned;
the durable sending claim still blocks duplicates.

### GET `/batches/:batchId/drafts/:draftId/email-attempts/:attemptId`

HTTP 200 returns `{ "attempt": { ... } }` using the same public attempt shape.
Owner and batch/draft association are enforced; unrelated/missing attempts
return 404 `SEND_ATTEMPT_NOT_FOUND`. Status inspection never sends or retries.

Keep the attemptId across network failures and inspect that attempt. Never
generate a replacement attempt just because an HTTP response was lost. Refetch
the batch to recover its emailAttemptId if browser state was lost.
`requiresReview:true` on sending is conservative, not a statement it failed.

Batches with any send-attempt history cannot be deleted:
409 `EMAIL_ATTEMPT_HISTORY_EXISTS`. This preserves duplicate-prevention evidence.

## Schema and release steps

`migrations/holiday-greetings-email.sql` adds **one** table,
`hg_email_attempts`, and a partial unique index. No existing table/column/record
is dropped or rewritten. Attempts reference owner, batch and draft; restrictive
foreign keys preserve history. Selection and method fields use the existing
versioned preference/draft records. Old SMS records remain unchanged.

Apply the additive migration to managed **development only**, through the
database tool or existing `scripts/prepare-holiday-development.js`. The script
now includes both Holiday migrations and must never target production, be put
in startup, or be added to deployment build hooks.

Managed production receives the new schema through the normal approved Publish
diff. Review for additions only. Never overwrite production with development
data or approve unrelated deletions. Runtime performs no new schema creation.

## Separate HOLIDAY_SETUP_REQUIRED diagnosis

Read-only production settings inspection for this change found **all eight**
Holiday settings absent:
HOLIDAY_GREETINGS_ENABLED, HOLIDAY_GOOGLE_CLIENT_ID,
HOLIDAY_GOOGLE_CLIENT_SECRET, HOLIDAY_TOKEN_ENCRYPTION_KEY,
HOLIDAY_SESSION_SECRET, HOLIDAY_OWNER_EMAIL, HOLIDAY_FRONTEND_ORIGIN,
HOLIDAY_GOOGLE_REDIRECT_URI.

The disabled/invalid configuration guard returns 503 before private DB access;
it is not evidence of a failed Google exchange. The prior production schema
check confirmed all six base tables. The new attempt table still needs its
approved schema publication. Production feature configuration is unchanged.

Before approval to enable:
1. Configure the dedicated owner Web OAuth client and enable People + Gmail APIs.
2. Store credentials securely; use independent encryption/session keys, not
   Pray Over Us SESSION_SECRET. Preserve these keys once used.
3. Keep the exact callback above and frontend origin
   `https://who-call-paul.replit.app`.
4. Implement/verify the same-origin frontend proxy and explicit review/send UI.
   The prior public frontend `/session` check returned 404; this separate
   frontend has not been changed here.
5. Review the additive schema diff and approve publication separately.
6. Enable only with approval, reconnect for Gmail send scope, then perform
   owner-approved real-device testing. No real send was authorized for this work.

Google reference:
https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
