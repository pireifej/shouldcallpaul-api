# Mobile compatibility handoff: interim access and member history

Backend source changes only. Not deployed. No migration, production data edits,
purchase operations, store configuration, or Cloudinary changes are required.

## Shared authentication

Both routes below require existing application Basic authorization and a valid
user session (`x-user-session-token` or `user_session_token` cookie).

Missing/expired sessions return HTTP 401 `USER_SESSION_REQUIRED`. If supplied,
body `userId`/`user_id` identifies the signed-in viewer and must match the session,
otherwise HTTP 403 `USER_ID_MISMATCH`. Never use that field for another member.

## 1. Discover content-access policy

**GET `/api/subscriptions/access-policy`**

No body or query parameters are needed. Response HTTP 200:

```json
{
  "contentPaywallEnabled": false,
  "dailyBread": { "requiresPro": false },
  "prayerWalk": { "requiresPro": false },
  "extendedPrayer": { "requiresPro": true }
}
```

This is a server release policy, not the current user's subscription status.
It returns no `isPro` flag, customer identity, or private account data. It performs
no database or RevenueCat calls and works during RevenueCat outages.
Response header: `Cache-Control: private, no-store`.

The policy uses the same configuration resolver as the actual feature gates:
`PRAY_OVER_US_CONTENT_PAYWALL_ENABLED`, absent/false by default. Setting it to
`true` in a later approved release makes Daily Bread and Prayer Walk's
`requiresPro` fields true. `extendedPrayer.requiresPro` remains true in both modes.
Policy and guards are captured when the server routers initialize; changing the
environment requires the normal approved restart/redeployment process.

Frontend rules:

- Fetch after sign-in and refresh when the app foregrounds. Keep policy separate
  from account-specific Pro status; never set `isPro: true` to enable free content.
- When a feature's `requiresPro` is false, allow signed-in users to open it
  without waiting for a successful RevenueCat status response.
- When true, apply verified Pro status and the paywall. Backend authorization
  remains authoritative; handle HTTP 403 `PRO_REQUIRED` even if local policy is stale.
- Authentication failures prompt sign-in, not an upgrade screen.
- Treat unavailable/malformed policy responses explicitly as a retryable
  access-policy failure, not as proof the user needs to buy Pro. Do not infer a
  new policy silently from cached purchase status.
- This endpoint will not exist in the older deployment. Do not assume it is live
  until the backend is published and checked. Coordinate release order and
  explicitly handle an older-server 404 rather than treating it as Pro denial.

The policy covers full Daily Bread readings, current/archive audio, archive
browsing, read rewards, and both Prayer Walk aliases. The public
GET `/getDailyDevotional` remains a preview with `locked: true`; that preview flag
does not override interim signed-in access through the full-content POST routes.

Cloudinary URLs intentionally stay public. Audio generation/saving are unchanged.
Hiding playback does not revoke already known public media URLs.

## 2. Read another member's prayed-for history

**POST `/getPrayedFor`**

To view another member, authenticated as viewer 42:

```json
{
  "userId": 42,
  "targetUserId": 43,
  "lang": "en"
}
```

`userId` may be omitted because the verified session identifies the viewer.
`targetUserId` must be a positive safe integer, supplied as a JSON integer or
digits-only string. Invalid/null/empty/zero/fractional targets return HTTP 400:

```json
{
  "error": "INVALID_TARGET_USER_ID",
  "message": "targetUserId must be a positive safe integer."
}
```

For the signed-in user's own history, old valid requests continue working:

```json
{ "userId": 42, "lang": "en" }
```

Omitting `targetUserId` always selects the session account. `{}` also selects the
session account with English. Spanish is supported with `"lang": "es"`; the
existing fallback to English for other values is unchanged.

Response stays the existing JSON array of standard request/prayer rows. An empty
result stays `[]`; no envelope or pagination was introduced. The existing
`r.active != 3` filter, joins, fields, and ordering remain unchanged. No detailed
or extended prayer fields were added. This change does not claim to add any new
blocking/privacy filters beyond the existing query.
Response header: `Cache-Control: private, no-store`.

**Required frontend correction:** do not send the viewed member's ID as `userId`.
An old request `{ "userId": 43 }` with viewer 42's session intentionally still
fails with 403 `USER_ID_MISMATCH`. There is no insecure compatibility exception.

## Verification and remaining release checks

`node --test --test-concurrency=1 tests/*.test.js`:
**200 passed, 0 failed, 0 skipped**.

The full suite includes real disposable PostgreSQL quota/concurrency tests.
New regressions cover policy authentication, both policy modes matching actual
gates, zero provider/database access for policy discovery, provider outage,
member selection, own-history compatibility, numeric-string targets, empty
history, invalid targets, visibility SQL, viewer mismatch, and expired sessions.
Syntax checks and `git diff --check` passed.

Changed runtime files: `interimContentAccess.js`, `routes/subscriptions.js`,
`routes/prayers.js`.
Tests: `tests/pro-feature-boundaries.test.js`,
`tests/prayed-for-identity.test.js` (new).

This does not complete the separate frontend's token-storage, SDK identity,
purchase/restore, account switching, reward-marker, or composer-error work.
The normal server was not started because startup runs database migrations.
No deployed endpoint or mobile UI was verified. Verify the frontend changes
against this contract and perform signed-in free-user device smoke tests before
calling the combined release ready.
