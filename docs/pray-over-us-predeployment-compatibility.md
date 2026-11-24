# Pray Over Us: pre-deployment mobile compatibility review

## Decision

**NOT READY for a production compatibility guarantee or production deployment.**
The backend is ready for isolated compatibility investigation, but released
mobile binaries and real purchase/restore flows were not available to test.
Several source-level incompatibilities are reproducible and need resolution
or evidence that no supported released version uses the affected contracts.

No runtime code, credentials, application configuration, production data,
RevenueCat customers or deployment was changed during this review.
Only regression tests and this report were added.

## Content paywall

`PRAY_OVER_US_CONTENT_PAYWALL_ENABLED` was absent from both development and
production configuration, including inherited shared configuration. Its effective
value in the reviewed source is **false**, as required. It was left unchanged.
The full regression suite was also run with the process-local value `false`.
This does not attest to which source revision or effective in-memory policy the
currently deployed process is running.

Daily Bread, its current/archive audio, and Prayer Walk remain available to
authenticated signed-in free users. The switch does not bypass personal-session
verification, grant Pro, or make extended prayer content free.
Cloudinary URLs and audio generation/storage are unchanged.

Evidence: `interimContentAccess.js`,
`tests/pro-feature-boundaries.test.js`, and configuration existence inspection.

## Sign-in and older sessions

- `/login` keeps the existing `error`/`result` response and returns
  `user_session_token` both at the top level and in the user row. It also sets
  the secure session cookie.
- Protected operations require the existing app authentication plus a signed
  session in `x-user-session-token` or the `user_session_token` cookie.
- A valid version-1 token issued 29 days ago still loads
  `POST /getCommunityWall`, with either the header or cookie. No forced session
  version migration was found.
- Tokens expire after 30 days by default. Expired, missing, tampered or
  different-secret tokens return HTTP 401 `USER_SESSION_REQUIRED`.
- A mismatching body `userId`/`user_id` returns HTTP 403 `USER_ID_MISMATCH`.
- Shared Basic credentials, a remembered user ID, a RevenueCat ID, a body token,
  or a Bearer token alone do not substitute for the supported session transport.
- There is no refresh-token exchange in the reviewed session implementation.
  Expired clients must obtain a fresh session by signing in again.
- Rotating `SESSION_SECRET` invalidates sessions and changes the derived
  RevenueCat account identities. Do not rotate it as part of this release.

**Breaking contract:** older clients that did not persist/send the signed token
or cookie will not regain community/posting access merely because the backend
successfully accepted their login. Re-login helps only if the binary actually
retains and sends the returned session.

Existing tests exercise email login, Google proof-cookie login, and verified
Google/Facebook/Apple identity handling with synthetic provider responses.
They are not live-device sign-in or production provider configuration tests.
Production/shared configuration inspection found Apple's client ID configured,
but **Facebook app ID and app secret absent**. `providerIdentity.js` requires
both for Facebook sign-in; that flow returns a setup failure without them.
Whether Facebook is exposed in supported released versions needs confirmation.
No secret values were retrieved or printed.

Evidence: `userSession.js`, `routes/auth.js`, `providerIdentity.js`,
`tests/user-session.test.js`, `tests/mobile-release-compatibility.test.js`.

## Community prayers and permitted free posting

With a valid session, `POST /getCommunityWall` preserves its array response.
The new characterization test uses an empty synthetic wall and checks that
rejected sessions do not reach the database; it reads no real prayers.

`POST /createRequestAndPrayer` and `POST /api/prayers/post` still permit one
successful standard free request per America/New_York calendar day:

- The permitted final request returns HTTP 200 with success even when the
  remaining allowance is zero.
- Only a later additional attempt returns HTTP 403 with
  `error: "DAILY_LIMIT_REACHED"`.
- Prayer generation failure or failed prayer persistence does not spend quota.
- Concurrent free posts cannot both consume the same allowance.
- Verified Pro bypasses the free-tier quota.
- Posting ignores untrusted client RevenueCat IDs/Pro flags as authorization.

**Additional dependency:** posting still checks RevenueCat status. A provider or
identity-verification service failure is HTTP 503, not a free-tier rejection.
Turning off the content paywall does not remove that dependency. Device UI must
not turn those failures or a successful final allowed post into an upgrade
error. The legacy-fields posting regression assumes a valid signed session; it
does not demonstrate that a released binary sends one.

Evidence: `tests/free-tier-posting-routes.test.js`,
`tests/posting-postgres.test.js`, `tests/free-tier-calendar-day.test.js`,
`tests/pro-subscription.test.js`.

## Numeric/legacy RevenueCat identities and existing purchases

The backend derives `pou_v1_...` from the verified application account and
`SESSION_SECRET`. `POST /api/subscriptions/identity` returns that identity,
including for accounts with an existing numeric/anonymous mapping.

Reproduced cases for `POST /api/subscriptions/pro-status`:

| Existing state / request | Current result |
| --- | --- |
| No stored mapping; client sends JSON number as RevenueCat ID | HTTP 400: ID must be a string |
| No stored mapping; client sends numeric string such as `"42"` | HTTP 403 `SUBSCRIPTION_IDENTITY_MISMATCH` |
| No stored mapping; client omits RevenueCat ID | Checks only the derived customer, not the historical numeric customer |
| Saved numeric or anonymous mapping; no provider-confirmed alias to the derived customer | HTTP 200, `isPro: false`, `identityVerificationRequired: true`; mapping unchanged |
| Saved mapping; provider confirms alias, and derived customer has active entitlement | HTTP 200, `isPro: true`; mapping unchanged |
| Conflicting client identity for an already-mapped account | HTTP 409 `SUBSCRIPTION_IDENTITY_MISMATCH` |

**Breaking contract:** an existing active store purchase under a numeric or
anonymous identity is not sufficient by itself for backend Pro recognition.
An older SDK installation that never logs into the server-issued identity may
remain unrecognized, even with a paid legacy customer. No automatic lookup or
trust-based fallback to a numeric account ID was introduced.

This protects ownership but is a compatibility blocker until an approved,
verified migration/restore path is demonstrated for supported released apps.
Do not solve it by trusting a client-selected customer or overwriting mappings.
Tests do not establish that live RevenueCat SDK login/restore creates the needed
alias or that purchase-transfer settings permit the intended behavior.

Evidence: `revenueCatProService.js`, `routes/subscriptions.js`,
`tests/subscription-ownership.test.js`,
`tests/mobile-release-compatibility.test.js`.

## Verification performed

Command:

```sh
PRAY_OVER_US_CONTENT_PAYWALL_ENABLED=false node --test --test-concurrency=1 tests/*.test.js
```

**230 passed, 0 failed, 0 skipped.** Includes real isolated PostgreSQL
posting/concurrency/rollback checks. Six new characterization regressions cover
older sessions, numeric IDs, saved numeric/anonymous mappings, and confirmed
legacy aliases. `git diff --check` also passed.

Passing characterization tests reproduce both supported behavior and intentional
rejections; they do not mean old binaries are compatible. The normal application
was not started because its startup performs database migrations. No deployed
endpoint, real provider account, released mobile UI, purchase or restore was tested.

## Evidence needed from the mobile project / controlled device checks

1. Identify the oldest supported released iOS and Android build numbers and
   provide their source or sanitized API/SDK contract. Do not share real session
   tokens, customer IDs, credentials, personal data or prayer text.
2. Verify those exact binaries persist and send the session after each offered
   sign-in flow, app restart and background/foreground transition. Test an
   already-signed-in installation and a fresh login. Check expired-session
   recovery; never substitute a body user ID for the session.
3. Load the community wall, make the one permitted free post, confirm its
   success UI with zero remaining, then confirm the second attempt is rejected.
   Simulate a generation failure before retrying. Use designated test accounts.
4. Show precisely how released builds configure RevenueCat: numeric/string IDs,
   anonymous IDs, SDK `logIn`, `logOut`, purchase, restore and account switching.
5. In an approved isolated/sandbox environment, verify an existing numeric
   purchase and an anonymous legacy purchase on both stores. Demonstrate backend
   Pro after login/restore without cross-account purchase access or mapping
   replacement. Verify Pro posting bypass and extended-content access too.
6. Confirm which sign-in providers released builds expose; configure/verify
   Facebook if supported. Credential presence alone is not a live sign-in test.
7. Confirm `GET /api/subscriptions/access-policy` returns
   `contentPaywallEnabled: false` on the approved test backend, and open full
   Daily Bread, archive audio and both Prayer Walk aliases as a free user.
8. Keep production deployment on hold until the compatibility blockers are
   resolved and the owner explicitly approves publishing.
