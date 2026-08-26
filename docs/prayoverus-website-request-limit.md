# PrayOverUs.com request-limit integration

Use this contract in the separate PrayOverUs.com project.

## Authentication

- Keep the API username and password in the website server's secrets. Never send them to browser JavaScript.
- Authenticate website API calls with `API_USERNAME` and the secondary `API_PASSWORD2` credential.
- The mobile app continues using the primary `API_PASSWORD` credential.
- The prayer API derives website/mobile status from the authenticated credential. Do not send a `source` field.

## Submission

The website may continue posting to:

`POST /createRequestAndPrayer`

It may alternatively use:

`POST /createWebsiteRequestAndPrayer`

Preserve the existing body fields, including `userId`, `requestText`, `requestTitle`, `sendEmail`, `tz`, and `idempotencyKey`. The daily allowance uses a fixed UTC calendar day; `tz` does not change the limit.

## Limit response

Handle HTTP `429` with this response:

```json
{
  "error": 1,
  "code": "WEBSITE_DAILY_LIMIT",
  "result": "You can post one prayer request per day from the website. To post additional requests, download the Pray Over Us app and sign in with the same credentials.",
  "downloadUrl": "https://prayoverus.com/download"
}
```

Show the `result` text and a prominent “Download the Pray Over Us app” link. Preserve what the user typed when this response occurs.