# Private Holiday Greetings: backend and frontend handoff

## Status and boundaries

The base SMS feature and its six tables were published, but setup remains
disabled (`HOLIDAY_SETUP_REQUIRED`). The contact-setup/Gmail extension is
implemented in source, not published. See
`docs/holiday-greetings-email-handoff.md` for the updated API, additive migration,
scope changes, safe sending states, and remaining setup. No production data,
configuration, Google consent or separate frontend was changed for the extension.

This feature uses the existing CRM `auditPool`; it does not read or modify
Pray Over Us accounts/prayers, CRM contacts/workshops, or public portfolio feeds.
All feature tables start with `hg_`. Individual explicitly reviewed Gmail sends
are supported by the extension. No cloud SMS, background sender, contact writes,
AI, or group-message functionality exists.

## 1. Configuration and Google setup

Use a dedicated **Web application** OAuth client for this feature. Do not reuse
the mobile app's client or expand its scopes.

Server-side secrets (never frontend env vars or chat):

- `HOLIDAY_GOOGLE_CLIENT_SECRET`
- `HOLIDAY_TOKEN_ENCRYPTION_KEY`: independently generated, base64-encoded 32 random bytes
- `HOLIDAY_SESSION_SECRET`: independent cryptographically random secret, at least 32 characters

Server configuration:

- `HOLIDAY_GREETINGS_ENABLED=true` only after schema/config/proxy setup is approved
- `HOLIDAY_GOOGLE_CLIENT_ID`: dedicated Web OAuth client ID
- `HOLIDAY_OWNER_EMAIL`: exactly the one approved owner Google account from the request
- `HOLIDAY_FRONTEND_ORIGIN=https://who-call-paul.replit.app`
- `HOLIDAY_GOOGLE_REDIRECT_URI=https://who-call-paul.replit.app/api/holiday-greetings/oauth/google/callback`

There are no defaults for these owner/origin/client/key values, no arbitrary
forwarded-host redirect construction, and no reuse of the Pray Over Us session.
Invalid/incomplete setup leaves this feature disabled without stopping other APIs.
Keep encryption keys stable; replacing one without an explicit re-encryption
migration makes stored authorization/state unreadable. Replacing the session
secret changes CSRF tokens; affected browsers must refetch `/session`.

Google Cloud:

1. Select the intended Google Cloud project and enable **Google People API**.
2. Configure Google Auth Platform branding, support contact, and audience/consent
   screen. For an External Testing app, add the permitted owner as a test user.
3. Request only `openid`, `email`,
   `https://www.googleapis.com/auth/contacts.readonly`, and
   `https://www.googleapis.com/auth/gmail.send`. Existing Contacts-only
   connections must reconnect before sending email; SMS remains compatible.
4. Create an OAuth **Web application** client. Register the exact redirect URI
   above. Register the frontend origin where Google asks for an authorized
   JavaScript origin; no client-side Google secret is used.
5. Store its ID/config and secret securely under the names above.
6. Implement the frontend forwarding routes below **before** starting consent.
   A Google callback to the current nonexistent forwarding route cannot work.
7. Enable only after approved deployment/schema review, then authorize through
   normal Android Chrome and verify actual owner consent and contacts access.

Google ID tokens are signature-verified with Google's RSA JWKS and checked for
issuer, audience/authorized party, expiry, issued-at, nonce, verified email and
the configured owner email. First verified consent pins Google's stable subject
in the database. Another subject cannot replace it, even with the same email.
OAuth state is browser-session-bound, expires in 10 minutes, and is consumed
atomically once. PKCE uses S256. Offline refresh tokens are encrypted with
AES-256-GCM and subject-bound authenticated context; absent replacement refresh
tokens preserve the old one.

**External Testing limitation:** because contacts scope is included, Google
documents a seven-day refresh-token lifetime for External apps in Testing.
Expect explicit reconnect requirements. Publishing/verification requirements
and consent-screen warnings must be reviewed in Google Cloud; they were not
configured here. Tokens can also be revoked or expire for other reasons.
Sources:
https://developers.google.com/identity/protocols/oauth2#expiration
https://developers.google.com/identity/openid-connect/openid-connect
https://developers.google.com/people/api/rest/v1/people.connections/list

## 2. Frontend proxy, cookies and CSRF

All browser requests use the frontend's own origin with
`credentials: "same-origin"`. Proxy paths unchanged to this backend under
`/api/holiday-greetings`. Do not send the browser directly to the backend origin.
Shared service/Basic credentials alone grant **no** access to this private data.
No `X-Owner-*`, client email, local GUI authorization flag, or app-account session
can establish Holiday Greetings ownership.

The frontend proxy must:

- Forward method, path, query (especially OAuth `state`, `code`, `error`), JSON
  body, `Content-Type`, `Accept`, the Holiday Greetings cookie, and
  `X-CSRF-Token`. Forward a genuine browser `Origin` when present.
- Require/validate same-origin browser mutations at the frontend as well.
  POST/PUT/PATCH/DELETE must reach the backend with
  `Origin: https://who-call-paul.replit.app`. Never accept arbitrary caller
  `Host`, `X-Forwarded-Host` or owner headers as proof.
- Same-origin GET fetches may omit Origin. OAuth start still requires the
  non-simple CSRF header; a supplied unapproved Origin is always rejected.
  The top-level Google callback normally has no Origin and is protected by
  its browser-bound state, nonce and PKCE instead.
- Forward incoming `__Host-hg-session` cookie to the backend; never interpret it
  as an owner identity locally. Do not log any cookie, callback URL/query, body,
  contacts, drafts, authorization code, token, or response payload.
- Forward only this feature's approved `Set-Cookie` response header:
  `__Host-hg-session`, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, **no Domain**.
  Preserve expiration/clearing headers. Do not rewrite it to a backend Domain or
  expose it through JavaScript.
- Preserve HTTP statuses, JSON errors, `Cache-Control: private, no-store`,
  `Pragma: no-cache` and `Referrer-Policy: no-referrer`.
- **Do not automatically follow upstream redirects.** Forward the callback's
  303 and Location plus its Set-Cookie to the browser. Its fixed destination is
  `https://who-call-paul.replit.app/?holidayGreetings=connected`.
- Exclude all feature routes from proxy logs, edge caching, service-worker
  caching, analytics URL capture and generic JSON-only redirect handlers.

Backend global payload/response logging is bypassed for this entire prefix
(case-insensitively); errors expose safe codes only, not SQL/provider bodies.
Its 256 KiB JSON parser also sanitizes malformed/oversized payload errors before
the legacy parsers can log or reflect their contents.
The private API does not enable cross-origin CORS.

### Browser authorization sequence

1. `GET /api/holiday-greetings/session`. This may create an anonymous 15-minute
   bootstrap session. Its response has no private contacts/drafts:
   ```json
   {
     "authenticated": false,
     "googleConnected": false,
     "csrfToken": "<opaque-CSRF-token>",
     "expiresAt": null
   }
   ```
2. `GET /api/holiday-greetings/oauth/google/start` with `X-CSRF-Token`.
   HTTP 200: `{ "authorizationUrl": "https://accounts.google.com/..." }`.
   Navigate the top-level browser to this URL. Do not iframe it.
3. Google returns to the exact frontend callback; the proxy forwards it with
   the browser cookie. Backend consumes state and exchanges/verifies the code.
   On success it rotates the session cookie and redirects 303 to the fixed
   frontend destination. Do not expect a JSON body here.
4. Refetch `/session` to get the rotated session's CSRF token:
   ```json
   {
     "authenticated": true,
     "googleConnected": true,
     "csrfToken": "<new-CSRF-token>",
     "expiresAt": "2026-12-08T12:00:00.000Z"
   }
   ```
   Date is illustrative. Owner sessions expire after 14 days, are stored
   durably as hashed random tokens, and can be revoked by logout.

Keep CSRF in page memory and refetch it after reload/rotation; do not store
contacts, private preferences, drafts or durable progress in browser storage.
The initial bootstrap's `expiresAt` is null; subsequent session reads return its
actual database expiry. The bootstrap cookie's browser lifetime does not extend
the server's short bootstrap expiry.

Every endpoint below except the anonymous bootstrap and OAuth establishment
requires a verified owner session. OAuth start requires a valid browser session
and CSRF. Every mutation requires CSRF and the approved Origin.

## 3. Exact endpoints

All paths below have prefix **`/api/holiday-greetings`**:

| Method | Suffix | Success |
| --- | --- | --- |
| GET | `/session` | 200 session/CSRF state |
| GET | `/oauth/google/start` | 200 authorizationUrl |
| GET | `/oauth/google/callback` | 303 redirect + rotated session |
| POST | `/logout` | 200 `{ "success": true }`, clears/revokes this session |
| POST | `/google/disconnect` | 200 `{ "disconnected": true, "providerRevoked": true }` |
| GET | `/contacts?search=Alex&pageSize=50&pageToken=...` | 200 contacts page |
| GET | `/preferences` | 200 `{ "preferences": [...] }` |
| PUT | `/preferences` | 200 saved preference and version |
| POST | `/batches` | 201 complete batch |
| GET | `/batches/current` | 200 `{ "batch": <batch-or-null> }` |
| GET | `/batches/:batchId` | 200 complete batch |
| PATCH | `/batches/:batchId` | 200 updated complete batch |
| PATCH | `/batches/:batchId/drafts/:draftId` | 200 updated complete batch |
| POST | `/batches/:batchId/drafts/:draftId/opened` | 200 persisted batch plus handoff |
| POST | `/batches/:batchId/drafts/:draftId/mark-sent` | 200 updated complete batch |
| DELETE | `/batches/:batchId` | 200 `{ "success": true }` |

Logout/disconnect accept `{}`. Logout does not revoke Google or erase saved
drafts. Disconnect immediately blocks Google access, keeps owner sessions/drafts,
and attempts provider revocation. If Google is unavailable it returns
`providerRevoked: false`: do not claim remote revocation succeeded. The encrypted
token remains inaccessible for contacts but available for a later disconnect
retry; successful revocation clears it. Reconnect uses the authorization flow.
Expired/revoked refresh consent returns 409 `GOOGLE_RECONNECT_REQUIRED`.

### Contacts

Example:
```json
{
  "contacts": [{
    "resourceName": "people/example-contact",
    "displayName": "Example Contact",
    "givenName": "Example",
    "photoUrl": null,
    "phoneNumbers": [{
      "value": "(202) 555-0101",
      "label": "mobile",
      "canonicalNumber": "+12025550101"
    }],
    "hasPhoneNumbers": true
  }],
  "nextPageToken": null,
  "searchAppliesTo": "page"
}
```

Each contact also has `photoUrl: string | null`: the primary non-default HTTPS
Google photo URL, falling back to the first usable non-default photo, or null.
Google placeholders are never returned as real photos. Photo URLs can change;
only `resourceName` identifies a contact. Photos use the existing
`contacts.readonly` permission; no additional OAuth scopes are requested.
The owner-only API and private/no-store headers are unchanged. No photo files
or URLs are stored permanently, fetched by the backend, or served by a new public
proxy. See `holiday-greetings-contact-photos-handoff.md` for secure display.

The identifier is the resourceName within the verified owner's Google account.
All phone choices are returned. No phone means `phoneNumbers: []`,
`hasPhoneNumbers: false`. Canonical number is null when Google supplies no valid
international form. No country code is guessed or prepended.

`pageSize` is 1–100. Omit pageToken initially; return nextPageToken on the next
call. Search filters each Google connections page by name/phone, so an empty
filtered page with a nextPageToken is **not** the end of search. Traverse all
pages for complete search results. No Google address-book snapshot is copied to
CRM. See Google's API quotas; retry quota failures rather than repeatedly paging.

### Preferences: versioned sparse updates

First save uses `version: 0`; updates supply the last returned version.
Omitted fields now preserve saved preferences. Defaults apply to first creation.
The extension also accepts `selected`, `preferredMethod`, and
`preferredEmailAddress`; see the email handoff for examples:
```json
{
  "resourceName": "people/example-contact",
  "version": 0,
  "greetingName": "Alex",
  "familyMode": "family",
  "familyCustom": "",
  "preferredPhoneNumber": "+12025550101",
  "personalNote": "",
  "occasions": {
    "thanksgiving": "ask",
    "christmas": "opt_in",
    "easter": "opt_out",
    "new_year": "ask",
    "custom:Birthday": "ask"
  }
}
```

Response is the same shape with `version: 1`. Defaults: empty greeting/note/custom
wording, `familyMode: "off"`, null preferred number, empty occasions (meaning ask).
Family modes: `off`, `family` (literal "you and your family"), `custom`.
Preference saves verify the contact belongs to the connected owner; a supplied
preferred number must be among that contact's current choices.

### Create a batch

```json
{
  "occasion": "christmas",
  "baseTemplate": "Hello {name}, wishing {family} a happy {occasion}! {note}",
  "recipients": [{
    "resourceName": "people/example-contact",
    "phoneNumber": "+12025550101",
    "confirmedForOccasion": true
  }]
}
```

Occasions: `thanksgiving`, `christmas`, `easter`, `new_year`, `custom`. Custom
requires nonempty `customOccasionLabel`. Between 1 and 200 explicitly selected,
unique recipients are required. No preference/contact is auto-selected.
For ask/default preferences, each selected recipient requires
`confirmedForOccasion: true`. Opted-out contacts are rejected, not silently added.

Phone selection is required when multiple choices exist and no valid saved
preference is used. A single available choice can be used automatically for an
already explicitly selected recipient. A saved number that disappeared causes
409 `CONTACT_PHONE_CHANGED`, never fallback to another number. Raw phone values
are retained when there is no canonical form; the frontend must display them
and must not invent an international prefix.

Templates allow only `{name}`, `{family}`, `{occasion}`, `{note}`. Substitutions
are literal and single-pass. Names come from explicit preferences or actual
Google name fields, never inferred beliefs/relationships. Recipients can supply
an individually edited `message` instead of generated template text.
Render all values as plain text, not HTML.

Complete batch example:
```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "version": 1,
  "occasion": "christmas",
  "customOccasionLabel": null,
  "baseTemplate": "Hello {name}, happy {occasion}!",
  "queuePosition": 0,
  "updatedAt": "2026-11-24T12:00:00.000Z",
  "drafts": [{
    "id": "22222222-2222-4222-8222-222222222222",
    "position": 0,
    "resourceName": "people/example-contact",
    "displayName": "Example Contact",
    "phoneNumber": "+12025550101",
    "message": "Hello Alex, happy Christmas!",
    "state": "draft"
  }]
}
```

All IDs/dates/contact details above are synthetic. Batch/draft IDs are stable UUIDs.
Position is zero-based. `queuePosition` may equal the draft count to indicate the
end of the queue. `/batches/current` selects the most recently updated owner batch.

### Save edits, skip, hand off, mark sent

All edits/deletes require the current **batch** `version`, not a separate draft
version. Every successful edit increments it. On 409, reload and resolve instead
of overwriting automatically.

Batch PATCH:
```json
{ "version": 1, "queuePosition": 1 }
```
Also accepts occasion/customOccasionLabel/baseTemplate. Changing a template does
not overwrite individually edited messages. Recipient membership is fixed after
creation; create a new batch for a different selection.

Draft PATCH:
```json
{ "version": 2, "message": "My edited greeting", "state": "skipped" }
```
Optional fields: message, phoneNumber, queuePosition, state (`draft` or `skipped`).
Only the dedicated action can mark a draft sent.

Before leaving Chrome, POST `/batches/:batchId/drafts/:draftId/opened`:
```json
{
  "version": 3,
  "message": "My final greeting",
  "phoneNumber": "+12025550101",
  "queuePosition": 0
}
```
Wait for HTTP 200 **before** invoking the native Messages composition link. The
response is the persisted complete batch (version 4), draft state
`opened_in_messages`, an `openedAt` timestamp, plus:
```json
{ "handoff": { "phoneNumber": "+12025550101", "message": "My final greeting" } }
```
This records a requested composition handoff only. It does not establish that
Messages opened or that the owner pressed Send. The browser/native URI behavior
belongs to the frontend. Return/reload uses `/batches/current` or the saved batch
ID; it must never infer delivery from focus/visibility changes.

After explicit owner confirmation, POST `/batches/:batchId/drafts/:draftId/mark-sent`:
```json
{ "version": 4, "confirmed": true }
```
Response: updated complete batch, version 5, state `manually_marked_sent` and
`manuallyMarkedSentAt`. Missing/false confirmation is rejected.

DELETE `/batches/:batchId` uses JSON `{ "version": 5 }`; only that owner's matching
version is deleted, cascading to its own drafts, not contacts/preferences.

### Error contract

Errors are JSON `{ "error": "<CODE>" }`, without private data/provider diagnostics.

| HTTP | Examples |
| --- | --- |
| 400 | `INVALID_FIELDS`, `VERSION_REQUIRED`, `UNKNOWN_TEMPLATE_FIELD`, `INVALID_TEMPLATE`, `INVALID_CONTACT_RESOURCE`, `PHONE_SELECTION_REQUIRED`, `OCCASION_CONFIRMATION_REQUIRED`, `MANUAL_CONFIRMATION_REQUIRED` |
| 401 | `OWNER_SESSION_REQUIRED` |
| 403 | `OWNER_ACCOUNT_REQUIRED`, `INVALID_OAUTH_STATE`, `CSRF_REJECTED`, `ORIGIN_FORBIDDEN`, `GOOGLE_CONSENT_DENIED`, `GOOGLE_SCOPE_REQUIRED`, `GOOGLE_ACCESS_DENIED` |
| 404 | `BATCH_NOT_FOUND`, `DRAFT_NOT_FOUND`, `CONTACT_NOT_FOUND` |
| 409 | `VERSION_CONFLICT`, `CONTACT_PHONE_CHANGED`, `CONTACT_HAS_NO_PHONE`, `CONTACT_OCCASION_OPTED_OUT`, `GOOGLE_RECONNECT_REQUIRED`, `GOOGLE_OFFLINE_CONSENT_REQUIRED` |
| 429 | `GOOGLE_QUOTA_EXCEEDED` |
| 503 | `HOLIDAY_SETUP_REQUIRED`, `HOLIDAY_SCHEMA_REQUIRED`, `GOOGLE_UNAVAILABLE`, `AUTHORIZATION_STORAGE_UNAVAILABLE` |
| 500 | `HOLIDAY_REQUEST_FAILED` |

## 4. Migration and release safety

`migrations/holiday-greetings.sql` adds six hg_ tables and one index, with no
changes to existing records/tables. It contains no imported contacts or seed data.
Runtime performs **no schema creation**. No new dependency was installed.
The email extension adds `migrations/holiday-greetings-email.sql`, containing
one send-attempt table and one partial unique index without rewriting old data.

Development preparation:
`node scripts/prepare-holiday-development.js`
uses development `DATABASE_URL` only. Do not change its target to
`NEON_DATABASE_URL`, put it in server startup, or add it to a deployment build.
The managed development schema was already prepared through the development
database tool during implementation; this command is provided for repeatability.

This project's CRM connection name does **not** prove it is outside managed
Publish. For managed production, review Publish's schema diff and apply schema
through that flow only after approval. Confirm additions only; do not approve
unrelated drops/renames or use overwrite-production-data.
If the actual runtime target is proven to be external/unmanaged instead, stop
and agree its existing migration process before any production write.
No custom production migration script or startup DDL was added.

## 5. Verification and what remains

Final verification: `node --test --test-concurrency=1 tests/*.test.js` completed
with **224 passed, 0 failed, 0 skipped**. Syntax checks passed for all new runtime
modules, the development preparation script and server entrypoint;
`git diff --check` passed.

Automated tests use synthetic identities, RSA-signed test ID tokens, mocked
Google HTTP, and a disposable local PostgreSQL server with no application
credentials. They cover owner rejection, signatures/claims, shared credentials
without owner sessions, state replay/browser binding/expiry, CSRF, encryption,
refresh/reconnect/disconnect/logout, resource associations, missing/multiple
phones, explicit occasions/recipients, cross-owner access, version conflicts,
manual sent confirmation and queue/draft/session survival across API/PostgreSQL
restarts. Other application regressions run with the normal test suite.

Still unverified:

- Real Google Cloud consent, client setup, People API quotas and actual contacts.
- The separate frontend proxy, cookie forwarding, callback and CSRF integration.
- Android Chrome -> existing Messages recipient/body handoff, conversation
  matching, SIM selection, and returning/reopening the saved queue.
- Any production route/schema/configuration and publishing diff.

No messages were sent, Google contacts read, or production changes published.
