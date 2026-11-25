# Pray Over Us subscription fixes and mobile integration

These changes are source-only. They have not been deployed. No production
customer records, prayer content, credentials, store settings, or RevenueCat
configuration were read or changed while implementing the fixes.

## Authentication and account binding

Subscription and protected content routes require both:

1. The existing application Basic authorization.
2. A verified user session in `x-user-session-token` or the
   `user_session_token` cookie.

The account is the verified session's `sub`, exposed internally as `req.userId`.
The middleware rejects a mismatching body `userId` or `user_id`. Do not use
device identifiers, email addresses, client `isPro` flags, or a client-selected
RevenueCat customer to establish ownership.

### 1. Get the account's RevenueCat identity

`POST /api/subscriptions/identity`

Request:

```json
{}
```

Response, HTTP 200:

```json
{
  "revenuecatAppUserId": "pou_v1_<server-generated-account-value>",
  "entitlement": "Pray Over Us Pro",
  "requiresSdkLogin": true
}
```

This endpoint does not link a customer, create a subscription, or grant Pro.
The opaque ID is derived by the server from the verified account using a
domain-separated HMAC. Keep `SESSION_SECRET` stable across instances and
environments that serve the same accounts. Secret rotation requires a planned
identity migration; never replace mappings automatically to hide a mismatch.
The identity is an identifier, not an API credential. Do not publish it in
public profiles, analytics, or support screenshots.

After app login, call this endpoint and configure or `Purchases.logIn()` to
**exactly** the returned ID before purchasing or restoring. On account switching,
clear the app's cached access and switch the RevenueCat SDK to the new account's
server-issued identity. Do not use another account's cached customer information.

### 2. Ask the backend for access

`POST /api/subscriptions/pro-status`

Request immediately after SDK login, purchase, restore, or an access refresh:

```json
{
  "revenuecatAppUserId": "pou_v1_<server-generated-account-value>",
  "refresh": true
}
```

The ID is optional: the server always derives the lookup customer from the
session. Supplying it is only a consistency check. `refresh: true` bypasses
the entitlement cache for **this account only**; it does not bypass ownership
verification, provider verification, or lookup concurrency limits.

Only this status handshake validates a supplied RevenueCat ID. Content and
posting routes ignore client RevenueCat IDs and Pro flags entirely and authorize
only the session-derived account. This preserves the free posting path for older
clients that still send an anonymous ID, without letting that ID grant Pro.

Response, HTTP 200:

```json
{
  "isPro": true,
  "entitlement": "Pray Over Us Pro",
  "revenuecatAppUserId": "pou_v1_<server-generated-account-value>",
  "identityVerificationRequired": false
}
```

First persistence requires the session-bound, server-derived identity plus an
active entitlement from the authenticated RevenueCat API for that exact
customer. An active arbitrary client-selected customer is insufficient.
Only confirmed active identities are saved. The existing unique constraint and
compare-and-set update prevent reassignment to another account or overwriting
an existing mapping.

For an existing anonymous mapping, a stored ID alone is not proof. RevenueCat
must report that stored ID among the aliases of the current server-derived
customer. The backend queries only the current account's canonical customer.
It never queries a supplied foreign customer to discover whether it is Pro.
Verified legacy mappings remain unchanged in the database. No bulk relinking,
entitlement flags, or historical ownership guesses are introduced.

If that alias proof is absent, status is HTTP 200 with `isPro: false` and
`identityVerificationRequired: true`. Stop and investigate ownership; do not
blindly switch the SDK, restore, clear a mapping, or force-link the old customer.
The mobile history guard must remain in place. A separately approved,
expired-sandbox-only transition is described in
[the identity reconciliation contract](pray-over-us-identity-reconciliation.md).
It does not grant Pro, merge customers, or transfer purchases.
An unrelated supplied ID returns 403 `SUBSCRIPTION_IDENTITY_MISMATCH`, or 409
when an existing mapping would conflict. Provider unavailability returns 503,
not a daily-limit error.

## Feature boundaries

The authenticated policy-discovery endpoint and viewed-member history contract
are documented in [the mobile compatibility handoff](pray-over-us-mobile-compatibility-handoff.md).
Use `GET /api/subscriptions/access-policy` for GUI access policy independently
of RevenueCat subscription verification.

### Interim access while IAP is unfinished

Daily Bread and Prayer Walk are temporarily available to all signed-in users.
`PRAY_OVER_US_CONTENT_PAYWALL_ENABLED` defaults to `false` when absent. No
environment setting was changed for this update. Both routers read the switch
when initialized; client request fields cannot override it.

When purchases/restores and the mobile paywall are ready, explicitly set
`PRAY_OVER_US_CONTENT_PAYWALL_ENABLED=true` in the intended server environment
and restart/redeploy through the approved release process. This is a manual
rollout decision, not a date-based or automatic switch. Invalid values fail
startup rather than silently bypassing the intended policy.

Both modes retain application authentication and verified user sessions on the
POST reading/audio/archive/reward routes. Interim access does not grant Pro or
alter the one-successful-free-post/day quota, RevenueCat identity security, or
extended-prayer restrictions. It skips RevenueCat checks for these temporarily
open features, so their availability does not depend on subscription verification.

When the switch is `true`, these routes also check the same `Pray Over Us Pro`
entitlement before reading content or any memory, disk, or provider audio cache.

| Endpoint | Access |
| --- | --- |
| `GET /api/requests` | Pro, including raw cached extended fields |
| `POST /getAllRequests` | Pro, including raw cached extended fields |
| `POST /getDetailedPrayerByRequestId` | Pro |
| `POST /api/prayers/generate`, `POST /testGeneratePrayer` with `extended: true` or `"true"` | Pro |
| Those generation endpoints with extended omitted/false | Free standard generation |
| `POST /getPrayer` | Standard prayer for free users; cached extended prayer only after Pro verification |
| `POST /getPrayerAudio`, `POST /api/prayer-walk/stream` | Signed-in now; Pro when switch is true |
| `GET /getDailyDevotional` | Existing public English preview only |
| `POST /getDailyDevotional`, `POST /api/daily-bread` | Signed-in full reading now; Pro when switch is true |
| `POST /getDailyDevotionalById`, `POST /getDailyDevotionalArchive` | Signed-in archives now; Pro when switch is true |
| `POST /getDailyBreadAudio` | Signed-in for all dates/caches/`checkOnly` now; Pro when switch is true |
| `POST /readDailyBread` | Signed-in read/reward now; Pro when switch is true |

Full-reading POSTs do **not** return a free preview on failure. While interim
access is open, the mobile app should allow signed-in free users to call the
POSTs without a Pro purchase screen. Once the switch is true, free accounts use
the GET preview endpoint. Its `result` contains title,
verse, reference, theme, image and `locked: true`, but no `article_body`, full
prayer, or audio URL.

Use the authenticated POST audio routes, including for archive playback. Missing
sessions return 401 `USER_SESSION_REQUIRED`; when a route requires Pro, inactive entitlements return:

```json
{
  "error": "PRO_REQUIRED",
  "message": "An active Pray Over Us Pro subscription is required."
}
```

The response is HTTP 403. Authorization-protected responses are marked
`Cache-Control: private, no-store` by the shared Pro guard.
Administrative manual devotional generation retains its separate admin-key
authorization and now fails closed if that key is unconfigured.

Cloudinary URLs intentionally remain public, per the owner's decision. Hiding
playback in the mobile GUI does not prevent listening through a known direct
URL; this is accepted, not a rollout blocker. No CDN assets were moved, deleted,
privatized, or reconfigured. Audio generation, saving, and scheduled preparation
are unchanged and independent of this switch. Clear account-specific app state
on logout/account change; apply GUI restrictions at the eventual paid rollout.

## Successful-post quota

These aliases share one allowance:

- `POST /createRequestAndPrayer`
- `POST /api/prayers/post`
- `POST /createWebsiteRequestAndPrayer` (still requires the website credential)

Free accounts get one **successful** post per `America/New_York` calendar day,
across website/mobile and all aliases. Verified Pro bypasses the free quota.
Device timezone, body user ID, and client-selected RevenueCat IDs cannot change
the account or quota.

Generation completes before any posting mutation. A provider exception, an
explicit provider error, or empty output returns HTTP 503:

```json
{
  "error": "PRAYER_GENERATION_UNAVAILABLE",
  "message": "Prayer generation is temporarily unavailable. Your daily allowance has not been used.",
  "retryable": true
}
```

The same idempotency key can be retried after such a failure. Do not show the
upgrade/daily-limit dialog for this error.

After generation, a short database transaction locks the free account, recomputes
the Eastern day after waiting for the lock, rechecks quota, and persists the
request, generated prayer, and their link together. A database failure rolls back
the whole pair. The quota counts only linked successful request rows, including
hidden/answered/archived successful posts; old incomplete rows do not count.
No transaction or quota lock is held while waiting for OpenAI.

Concurrent free attempts may both generate, but only one can commit for that
account/day. A successful final allowed post returns the existing HTTP 200
`success: true` response. Only a later attempt, or a concurrent attempt that loses
the commit-time check, gets HTTP 403:

```json
{
  "error": "DAILY_LIMIT_REACHED",
  "message": "Free tier is limited to 1 request per day. Upgrade to Pro for unlimited requests."
}
```

No data backfill, schema migration, or historical row deletion is required.

## Provider configuration and propagation

The server continues using the installed RevenueCat connector. It needs the
configured project, entitlement ID/key, and connector permission to read active
entitlements **and customer aliases**. No secret should be copied to the mobile app.

Purchases, restores, renewals, cancellations, and expirations become visible
through RevenueCat's authoritative active-entitlements API. Normal status caches
remain bounded at five minutes for active and one minute for inactive results.
Use the signed-account `refresh: true` call after purchase/restore and when
foregrounding the app. No webhook or external configuration was added here.
Cancellation alone must not remove access before the paid entitlement expires.
Automatic updates without refresh retain the documented cache delay.

## Exact mobile-to-backend checks still required before rollout

Use dedicated sandbox/test accounts only:

1. Sign in, obtain the opaque ID, log the SDK into it, and confirm the backend's
   status and SDK customer are for the same account. Try a foreign RC ID and
   mismatching app account ID; both must fail without linking.
2. On iOS, buy the monthly product, then call `pro-status` with `refresh: true`.
   Confirm `isPro: true`, unlimited posting and every Pro route. Repeat on Google
   Play. Confirm both monthly products are attached to `Pray Over Us Pro` and
   correctly approved/configured in their respective stores. API unit tests do
   not prove store approval, signing, receipts, billing permissions, or pricing.
3. Restore on another device for the same app account. For a pre-existing
   anonymous customer, confirm provider aliases establish the account binding
   without changing the stored mapping. Do not unlock if verification remains
   required.
4. Switch to a different/free app account on the same device. Confirm old SDK
   identity, cached status, reading and audio cannot grant Pro. Attempt a foreign
   customer ID on first linking; the backend must reject it.
5. Exercise sandbox renewal, cancellation while still paid, expiry and
   refund/revocation. Force a backend refresh at each transition, then check
   posting plus all premium routes. Also verify normal cache-delay behavior.
   Confirm sandbox/Test Store purchase configuration cannot grant unintended
   production access. Provider configuration was not changed in this work.
6. For a free account, force generation failure and retry; one valid post must
   succeed. The success must close the composer without a red rate-limit error.
   The next attempt must receive exactly 403 `DAILY_LIMIT_REACHED`. Send concurrent
   attempts and verify only one post exists. Repeat around Eastern midnight/DST.
7. With the switch absent/false, verify signed-in free accounts can use full
   Daily Bread, today/archive audio, warm caches, archives/read rewards, and both
   Prayer Walk aliases without a paywall. Missing/expired sessions still fail.
   Extended prayers and both raw request routes remain Pro-only in either mode.
   In an isolated test environment with the switch true, verify free accounts get
   the GET preview only and 403 on all full-content/audio routes, while Pro works.
8. Verify expired/missing sessions prompt app sign-in, provider failures show a
   retryable service error, and neither is mislabeled as a daily quota failure.

The backend regressions use synthetic data and isolated Express servers.
`tests/posting-postgres.test.js` additionally starts a disposable local PostgreSQL
process with no application connection strings and tests real transaction locks,
rollback, and Pro bypass. It skips explicitly if PostgreSQL binaries are absent.
The normal application server was not started during this source verification
because its startup also runs migrations against configured databases.

## Verification results and changed files

Prior subscription-audit fix baseline: **179 passed, 0 failed, 0 skipped**.
`node --check` passed for all seven changed runtime files; `git diff --check`
passed. Live mobile/store purchases and production routes were not exercised.

Runtime files:

- `revenueCatProService.js`
- `postingPersistence.js` (new)
- `freeTierRequestLimit.js`
- `routes/subscriptions.js`
- `routes/prayers.js`
- `routes/devotional.js`
- `routes/admin.js`

Regression files:

- `tests/subscription-ownership.test.js` (new): first-link ownership, signed
  identity handshake, immutable legacy mappings, provider aliases, uniqueness,
  cache refresh, and provider failures.
- `tests/pro-feature-boundaries.test.js` (new): app/session/Pro checks, raw
  extended-content reads, standard fallback, free preview, and warm current/archive
  audio caches.
- `tests/posting-postgres.test.js` (new): real concurrent transactions, failed
  prayer-write rollback, successful pair linkage, and Pro bypass in disposable PG.
- `tests/free-tier-posting-routes.test.js`: real Express route aliases, provider
  failures and same-key retries, concurrent failures/successes, atomic persistence,
  final-success/next-403 behavior, and old-client free posting compatibility.
- `tests/free-tier-calendar-day.test.js`: timestamp/timezone/DST checks with the
  successful-prayer fixture field and a regression for old incomplete rows.
- `tests/pro-subscription.test.js`: existing subscription/session/generation
  regressions updated for account-bound identities and the restored Pro gates.

The subsequent interim-access update adds `interimContentAccess.js`, uses it in
the devotional and prayer routers, and tests both switch modes in
`tests/pro-feature-boundaries.test.js`. Existing enforced-Pro tests explicitly
select paid mode. No database migration, data edit, or Cloudinary change is needed.

Interim-update verification:

- Initial full `npm test`: 190 passed, one failure from the disposable
  PostgreSQL `initdb` startup timeout, no skips.
- That PostgreSQL regression passed when rerun independently.
- After adding provider-lookup and client-switch-spoofing assertions, the
  feature-boundary/subscription suites passed all 45 tests.
- Syntax checks for the three changed runtime files and `git diff --check` passed.
- The normal server remains stopped to avoid its startup database migrations.
  Preview capture therefore returned connection refused; no mobile/visual or
  deployed behavior was verified.
