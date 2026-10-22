# Prayer posting daily-limit integration

Use this contract in the separate PrayOverUs.com and mobile frontend projects.
This supersedes the older website-only 429/download-app restriction.

## Authentication

- Keep the API username and password in the website server's secrets. Never send them to browser JavaScript.
- Authenticate website API calls with `API_USERNAME` and the secondary `API_PASSWORD2` credential.
- The mobile app continues using the primary `API_PASSWORD` credential.
- The prayer API derives website/mobile status from the authenticated credential. Do not send a `source` field.
- Also send the user's signed session token in `x-user-session-token`.
  The backend derives the member identity from that token; a supplied `userId`
  must match it.

## Submission

The website may continue posting to:

`POST /createRequestAndPrayer`

It may alternatively use:

`POST /createWebsiteRequestAndPrayer`

Mobile and website clients may also use `POST /api/prayers/post`.
All three routes share one handler and one allowance.

Preserve the existing body fields, including `userId`, `requestText`, `requestTitle`, `sendEmail`, `tz`, and `idempotencyKey`.

## Calendar-day policy

- Free users get **one request per calendar day in `America/New_York`**, shared
  across mobile, website and legacy posting routes. Pro users are unlimited.
- The allowance resets at **midnight Eastern**, automatically following EST/EDT.
  It is neither midnight UTC nor a rolling 24-hour cooldown.
- Client `tz`, device timezone and client-supplied dates cannot change this bucket.
- Hidden, archived, answered and edited successful posts still count.
- Example: a post at October 21, 2026 8:10 PM Eastern (October 22 00:10 UTC)
  counts for October 21. It does not block October 22's first Eastern-day post.
- Stored request timestamps remain UTC. Both midnight boundaries are calculated
  explicitly, so the DST transition days can contain 23 or 25 hours.
- The locked pre-insert check recomputes the day after acquiring the user lock.
  The inserted timestamp and website day use that same instant, even if waiting
  crossed midnight. The initial check cannot reserve an allowance.

## Limit response

Handle HTTP `403` with this exact response:

```json
{
  "error": "DAILY_LIMIT_REACHED",
  "message": "Free tier is limited to 1 request per day. Upgrade to Pro for unlimited requests."
}
```

Show the daily-limit message/upgrade choice only for `DAILY_LIMIT_REACHED`.
Preserve what the user typed. Do not turn unrelated authentication,
subscription-service, generation or network errors into a daily-limit message.
`PRO_REQUIRED` refers to a different, premium-only action.

No request or response fields changed for this calendar-day correction; older
clients remain compatible. No database migration or historical data rewrite is
required. The unused historical helpers in `websiteRequestLimit.js` are not
enforced by these routes and are not the current posting contract.