# Pray Over Us: approved sandbox identity reconciliation

## Release and approval boundaries

This is a backend **source-only** change. It is not deployed, enabled by an
operator approval record, or proof of a completed device migration.
No production approval, mapping, customer, alias, purchase, restore setting,
secret, or content-paywall configuration is changed by this implementation.
All examples and tests use synthetic identities.

The current identity contract is unchanged: derive the opaque `pou_v1_…`
customer from the verified app session and the unchanged signing secret.
Unapproved legacy mappings still require provider alias proof. This feature
does not introduce numeric-ID entitlement lookups or a legacy trust exception.
RevenueCat remains authoritative for Pro; an expired sandbox purchase grants
no access. Normal one-successful-free-request/day behavior remains unchanged.

## When this narrow procedure is eligible

A trusted operator must first independently review the signed account record,
its unchanged stored mapping, authenticated provider customer/aliases, and
device SDK current/original IDs. SDK diagnostics alone are not ownership proof.
An explicit approval is required for the exact account, configured project,
source, original anonymous alias, server-derived destination, and expiration.
There is no public or mobile-accessible approval endpoint.

Both offer and completion freshly inspect RevenueCat using **GET only**:

- Source is an **identified** legacy customer, not an anonymous ID or another
  opaque server-derived account.
- Source aliases are exactly the approved source and original anonymous alias.
  Extra, missing, or duplicate aliases stop the procedure.
- No active entitlement of any kind.
- At least one subscription; every subscription is expired, Google Play,
  sandbox, `gives_access=false`, and has valid past end/period-end timestamps.
- No one-time purchases, including sandbox purchases.
- No other app account maps to the source, original alias, or destination.
- Destination may be missing when offering the transition. If present, it must
  have exactly its own alias, no entitlements, no subscriptions, and no purchases.
- Completion requires that clean destination to exist in the configured project.

All provider pages are checked, with strict same-project/customer/resource
pagination validation and bounded work. Production history on a later page,
unexpected records, provider failures, malformed data, or incomplete pagination
must not be treated as an empty history.

## Authentication

Use the existing application Basic authorization plus the signed account
session in `x-user-session-token` (or the existing session cookie).
The account comes only from that session. Body `userId`, if present, must match
the session; it cannot select an account. Clear pending reconciliation state
and cached Pro/access state when the app account changes.

Every successful/operational-error response below is private/no-store. Never
log tokens, approval evidence, real customer IDs, or complete CustomerInfo.
The authorization UUID is an account-scoped handle, not a bearer credential;
knowing it without the matching verified session grants nothing.

## 1. Obtain the approved transition

`POST /api/subscriptions/identity`

Request: `{}`.

Unapproved/new/already-reconciled accounts retain the same HTTP 200 shape:

```json
{
  "revenuecatAppUserId": "pou_v1_<server-generated-account-value>",
  "entitlement": "Pray Over Us Pro",
  "requiresSdkLogin": true
}
```

An eligible account with an explicit, unexpired approval receives an additional
object, HTTP 200:

```json
{
  "revenuecatAppUserId": "pou_v1_<server-generated-account-value>",
  "entitlement": "Pray Over Us Pro",
  "requiresSdkLogin": true,
  "identityReconciliation": {
    "authorizationId": "12345678-1234-4234-8234-123456789abc",
    "action": "switch_without_restore",
    "fromAppUserId": "synthetic-legacy-customer",
    "toAppUserId": "pou_v1_<server-generated-account-value>",
    "expectedOriginalAppUserId": "$RCAnonymousID:synthetic-original",
    "expiresAt": "2030-01-02T15:00:00.000Z"
  }
}
```

This does not update a mapping, create a RevenueCat customer, mark completion,
approve another transition, or grant Pro. While still mapped to the unbound
legacy customer, `/pro-status` continues to return `isPro=false` and
`identityVerificationRequired=true`. Do not interpret that flag as permission
to restore or buy again.

Expired or conflicting approvals produce the errors below instead of an offer.
No approval record means no additional field or provider inspection for this
procedure. Nothing is inferred from a client-supplied approval object.

## 2. Separate mobile change required

The mobile app's general purchase-history guard must remain intact. It may
permit this one transition only after fetching the authenticated response above
and confirming:

1. The signed-in app account is unchanged from the account that fetched the
   response. The action is exactly `switch_without_restore`, the authorization
   has not expired, and `toAppUserId` equals outer `revenuecatAppUserId`.
2. SDK current ID exactly equals `fromAppUserId`, and cached CustomerInfo's
   original customer ID equals `expectedOriginalAppUserId`. Source is identified,
   not an SDK-anonymous current ID. Any mismatch stops for review.
3. The user explicitly confirms this controlled, no-transfer identity switch.

Keep purchase/restore buttons blocked throughout. Persist the account-bound
pending authorization safely across app interruption. Call **only**
`Purchases.logIn(toAppUserId)` directly; do not log out first, restore, sync
purchases, buy, create aliases, or transfer.

RevenueCat documents identified-to-identified login as a switch with **no
merge or purchase transfer**:
https://www.revenuecat.com/docs/customers/identifying-customers
The SDK may create the previously absent destination customer. The old customer
and expired sandbox history remain intact.

After login returns, independently check the SDK's current ID equals the target
and the app account still matches. A differing original ID at the new empty
customer is expected; do not require the source's original alias on the target.
Then call completion below.

**Interrupted flow:** If a securely persisted authorization matches the same
app account and the SDK already equals the approved target, skip another SDK
login and retry completion. Do not require source CustomerInfo after the switch.
Do not repeat a switch, switch back automatically, or allow a new arbitrary
target to bypass the guard. After expiry, a conflicting account, or changed
provider evidence, stop for operator review and keep purchases blocked.
The backend cannot prove which SDK ID a physical device currently uses; that
check is mandatory mobile behavior, not an assertion trusted from its request.

## 3. Complete the transition

`POST /api/subscriptions/identity-reconciliation/complete`

Only operation input:

```json
{ "authorizationId": "12345678-1234-4234-8234-123456789abc" }
```

Do not submit destination/source IDs, SDK booleans, Pro flags, or proof blobs.
The legacy matching `userId` session-consistency field is tolerated because
the session middleware supplies it; it is not an operation input.

HTTP 200:

```json
{
  "completed": true,
  "revenuecatAppUserId": "pou_v1_<server-generated-account-value>"
}
```

The backend rechecks provider evidence, locks the approval and account, verifies
the approval has not changed, and atomically:

- Compares the current mapping to the approved source and replaces it directly
  with the recomputed destination. It never clears the mapping.
- Sets `completed_at` on that approval in the same transaction.

Any failure rolls both changes back. Uniqueness prevents another account
claiming a mapped destination. No provider write occurs. A completed operation
can be replayed by the same account even after approval expiry, but only while
the mapping still equals its approved destination; the replay does not mutate
anything or depend on provider availability.

Refresh `POST /api/subscriptions/pro-status` with `refresh:true` afterward.
For this empty destination, expect HTTP 200:

```json
{
  "isPro": false,
  "entitlement": "Pray Over Us Pro",
  "revenuecatAppUserId": "pou_v1_<server-generated-account-value>",
  "identityVerificationRequired": false
}
```

The completed identity response no longer includes `identityReconciliation`.
Backend false/true Pro access remains authoritative; completion is not a grant.

## Errors

Errors are `{ "error": "<code>", "message": "<sanitized explanation>" }`.

| HTTP | Error | Mobile behavior |
| --- | --- | --- |
| 401 | Existing app-auth error or `USER_SESSION_REQUIRED` | Sign in; do not switch |
| 403 | `USER_ID_MISMATCH` | Stop account mismatch |
| 400 | `SUBSCRIPTION_RECONCILIATION_INVALID_INPUT` | Fix request; no operation occurred |
| 403 | `SUBSCRIPTION_RECONCILIATION_NOT_AUTHORIZED` | No matching approval; do not switch |
| 409 | `SUBSCRIPTION_RECONCILIATION_CONFLICT` | Mapping/approval/ownership changed; operator review |
| 409 | `SUBSCRIPTION_RECONCILIATION_REVIEW_REQUIRED` | Provider evidence differs; operator review |
| 409 | `SUBSCRIPTION_RECONCILIATION_TARGET_NOT_READY` | No destination customer; verify SDK/project without restore |
| 410 | `SUBSCRIPTION_RECONCILIATION_EXPIRED` | Operator must review/reapprove; never extend locally |
| 503 | `SUBSCRIPTION_RECONCILIATION_PROVIDER_UNAVAILABLE` | Retry evidence check; never treat as inactive |
| 503 | `SUBSCRIPTION_RECONCILIATION_UNAVAILABLE` | Retry backend; no automatic mapping reset |

An HTTP timeout is not proof the transaction failed. Retry the same completion
with the same signed account and authorization; its response is idempotent.

## Database preparation and operator approval

`migrations/subscription-identity-reconciliation.sql` adds
`subscription_identity_reconciliations`, its checks/unique constraints, and its
account foreign key. The legacy development account table has no unique key on
`user_id`, so the migration also adds
`user_subscription_reconciliation_user_id_idx` on that existing column, a
prerequisite for the foreign key. This is additive but must be reviewed: any
duplicate account IDs abort migration rather than being modified or deduplicated.
Development preflight found zero conflicting ID groups. Before production
publication, verify the production count and the actual managed Publish diff
with authorized production access. It seeds no rows and changes no mapping.
`scripts/prepare-subscription-development.js` and the post-merge hook prepare
**development only**. No startup or deployment-build migration was added.
Managed production schema changes require a separately approved Publish diff;
never overwrite development data into production or approve unrelated drops.

The runtime table is an operator-owned authorization/audit record, not an
entitlement table. Fields:
`id`, `user_id`, `project_id`, `from_customer_id`, `to_customer_id`,
`original_customer_id`, `approved_at`, `approved_by`, `expires_at`,
`completed_at`, `evidence_reference`.
Unique constraints protect user, source, original alias and destination per
project. Existing account mapping uniqueness remains in force.

After source review, mobile integration, separately approved schema publication,
and fresh identity/provider checks, a trusted operator may separately approve
adding **one** exact authorization row with a short, explicit expiry. Approval
must use the server-derived target, not a copied client-selected destination.
Store only a sanitized review reference and operator identifier, never receipts,
tokens, emails, or complete diagnostics. Do not ship a seeded customer, allowlist
of real identities, SQL containing real identifiers, or mobile approval endpoint.
No production authorization is included with this implementation.

Provider evidence and the database cannot share a transaction. The checks are
fresh but cannot prevent another device/store event from changing RevenueCat
after inspection. Coordinate this controlled procedure on the reviewed device,
keep all purchase/restore actions blocked, and stop if anything changes. This
is not a general paid-customer migration tool.

## Separate approvals and remaining device checks

1. Approve/publish source and additive schema separately; this alone authorizes
   no customer because the new table starts empty.
2. Implement the narrow mobile exception in its separate project. Test rejected
   approvals, anonymous/unexpected SDK IDs, account switching, interruption after
   login, completion timeout/retry, and expired approvals with mocks first.
3. Recheck the exact reviewed account/provider history and explicitly approve
   its production authorization record. No mapping change occurs on insertion.
4. On the reviewed device, confirm the switch and completion, then check SDK
   target ID and backend `false/false` flags. Old sandbox history must remain.
5. Verify free posting still allows one successful Eastern-calendar-day request
   and rejects only later attempts; Daily Bread/Prayer Walk remain available
   while the content paywall is false. No real send, paid purchase, restore, or
   broader store rollout is required by this backend implementation task.

## Verification of this source change

- Full backend suite: `node --test --test-concurrency=1 tests/*.test.js`,
  **301 passed, zero failures, zero skips**. Serial file execution avoids the
  known resource contention between disposable PostgreSQL initializations.
- New synthetic service/HTTP tests cover approval scoping, current ownership
  protection, provider history, complete/unsafe pagination, strict request
  inputs, provider errors, pending/replayed completion, and free-versus-Pro
  status after reconciliation.
- New real disposable PostgreSQL tests cover the legacy no-key schema,
  migration reruns, duplicate-ID rejection without record changes, constraints,
  concurrent completion, atomic rollback, approval edits, expiry, and a target
  claimed by another account at commit time.
- The older-mobile compatibility fixture now explicitly returns zero approval
  records for unapproved legacy customers; its original assertions are preserved.
- Development schema was prepared, with **zero approvals**. No existing
  development mapping or account content was changed.
- Production feature-switch presence inspection found no content-paywall
  setting; existing code therefore keeps its default `false`. No setting or
  session/encryption secret was modified.
- The production schema-diff request was rejected because this task environment
  lacks authenticated production access. **The actual pending Publish diff and
  production duplicate-ID count are not verified here.** Review all pending
  changes in the authenticated main project before publication, including
  unrelated earlier migrations; do not assume this is the only pending change.
- The normal shared server was not started: its existing startup code performs
  database mutations against configured pools. Verification used isolated
  Express servers and disposable PostgreSQL, never live customers or SDKs.

An authorized production read-only check for the prerequisite index is:

```sql
SELECT count(*) AS conflicting_id_groups
FROM (
  SELECT user_id
  FROM public."user"
  WHERE user_id IS NOT NULL
  GROUP BY user_id
  HAVING count(*) > 1
) duplicates;
```

Any nonzero result blocks publication of that unique index until a separately
approved investigation. Do not delete, renumber, deduplicate, or select an owner
automatically. Also verify existing customer-mapping conflicts remain absent.
