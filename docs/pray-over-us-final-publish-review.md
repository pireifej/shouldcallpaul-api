# Final pre-publish review

## Scope and accepted disruption

The owner supplied frontend confirmation of signed-session storage and header
transport, server-issued RevenueCat identity, and backend-verified Pro access
in current mobile source. Released-device purchase/restore tests remain
outstanding. Temporary older-client disruption is accepted; completion of the
store rollout is not a publication prerequisite for this review.

No runtime source, environment configuration, credential, purchase mapping,
production data or deployment was modified by this review.

## Exact pending managed production schema changes

The current read-only Publish diff contains 12 statements:

- Create `hg_batches`, `hg_drafts`, `hg_oauth_states`, `hg_owner`,
  `hg_preferences`, and `hg_sessions`.
- Create `hg_batches_owner_updated_idx`.
- Add five foreign keys: sessions to owner, OAuth states to sessions,
  preferences to owner, batches to owner, drafts to batches.

There are no proposed removed tables, removed columns, removed schemas,
truncations, or removed materialized views. The diff reports
`hasStructuralDataLoss=false`, `maybeNonBackwardsCompatible=false`, and no
warnings. All foreign keys attach new Holiday Greetings tables to each other;
none cascade into existing CRM, portfolio or prayer records.

This is a current schema snapshot, not a promise about later Publish changes.
Do not choose to overwrite production data with development data. If the
interactive Publish dialog differs, stop and review the new statements.

## Separate startup mutation concern

`server.js`, in `ensureWebsiteRequestLimitSchema`, contains existing code that
finds duplicate non-null `revenuecat_app_user_id` mappings and clears all
affected mappings before creating the unique index. It runs for both pools.
This is application-startup DML, not part of the 12-statement Publish diff.

Read-only managed production inspection found:

- Mapping column present.
- Mapping unique index present.
- Zero duplicate mapping groups.
- Speaker catalog already initialized.
- Zero CRM workshop rows requiring the old status normalization.
- Zero CRM workshop rows requiring the old structured-fee backfill.

Therefore no mapping reset or those CRM backfills are expected on the checked
production database in its inspected state. However, the automatic reset
capability still exists in source, and this inspection does not independently
attest to every database reached through both application pools. A strict
deployment-without-reset safeguard should remove the clearing branch and
report/fail explicitly on duplicate mappings without changing them.

No startup path was executed during this review. No conflict was repaired,
mapping cleared, customer merged or purchase transferred.

## Other projects and shared authentication

- Shared Basic authentication still supports both existing application
  credentials and distinguishes website/mobile request sources. No global
  Pray Over Us session or Pro middleware was added.
- Who Call Paul CRM contacts, workshops, resources, sessions, activity logs,
  organizations, notes and private resume-management endpoints use their
  existing Basic authentication, not a Pray Over Us Pro entitlement.
- Public `/resume/:filename`, `/resume_data/:filename`,
  `/speaker/speaker_menu` and `/speaker_data/speaker_menu.json` feeds remain
  public/database-backed, without a new mobile-session or Pro requirement.
- Holiday Greetings parsing, authentication, cookies and CORS restrictions are
  scoped to `/api/holiday-greetings`; it remains disabled without its setup.
- PrayOverUs.com is affected by the same signed-session protections as the
  mobile app if it calls the shared posting, profile, community or audio
  endpoints. Shared Basic credentials alone no longer suffice on those routes.
  The website must send the personal session too. Current mobile source
  confirmation does not verify that separate website.
- Consumers of `GET /api/requests`, `POST /getAllRequests`, and extended-content
  routes need a signed session and Pro. Turning off the content paywall does
  not remove those extended-prayer boundaries.

These are source-level route checks, not a live browser test of the separate
websites or an exact deployed-source comparison. Any failed required startup
initialization could prevent the shared API process from serving every project,
so the impact of startup failure is not limited to the mobile app.

## Purchase ownership and configuration

Client-selected customer IDs or Pro booleans do not establish access.
The verified session determines the application account and opaque RevenueCat
identity. First links require provider-confirmed active entitlement.
Existing legacy mappings require provider alias confirmation and are not
silently replaced by normal subscription requests. Uniqueness and
compare-and-set checks reject conflicts.

No explicit purchase-transfer or mapping-reset operation was performed.
RevenueCat SDK alias/restore/transfer behavior on real devices and store
configuration remains unverified; backend ownership regressions are not a
guarantee against every external account-switch/restore issue.

`SESSION_SECRET` exists and was left untouched; its value was not retrieved.
`PRAY_OVER_US_CONTENT_PAYWALL_ENABLED` is absent and resolves to **false**.
It was not enabled. Signed-in Daily Bread and Prayer Walk access stays open;
Cloudinary delivery and generation/storage are unchanged.

## Evidence and recommendation

The unchanged runtime source last passed **230 tests, zero failures or skips**,
including account binding, conflicting identities, legacy aliases, session
compatibility, free posting, real PostgreSQL quota races, CRM, portfolio,
workshop links/resources, and Holiday Greetings. The tests were not needlessly
rerun during this read-only review.

**Database diff: ready, additive only.**

**Accepted mobile compatibility/store-testing gaps: not a publication veto.**

**Remaining source safeguard: remove automatic startup mapping clearing before
giving an unconditional no-reset publication recommendation.** This is distinct
from the accepted mobile disruption and does not require a frontend store
release. No production deployment has been performed.
