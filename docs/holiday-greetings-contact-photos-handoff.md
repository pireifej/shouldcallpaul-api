# Holiday Greetings optional contact photos

Backend source change only; requires an approved backend publish.
No database migration, photo storage, new scope, or Google Contacts write.

## Exact contacts response

`GET /api/holiday-greetings/contacts?pageSize=50&pageToken=...&search=...`
through the existing same-origin, cookie-aware private frontend proxy:

```json
{
  "contacts": [{
    "resourceName": "people/synthetic-friend",
    "displayName": "Synthetic Friend",
    "givenName": "Synthetic",
    "photoUrl": "https://lh3.googleusercontent.com/synthetic-primary-photo",
    "phoneNumbers": [{
      "value": "(202) 555-0101",
      "label": "mobile",
      "canonicalNumber": "+12025550101"
    }],
    "hasPhoneNumbers": true,
    "emailAddresses": [{
      "value": "friend@example.invalid",
      "label": "home"
    }],
    "hasEmailAddresses": true
  }],
  "nextPageToken": null,
  "searchAppliesTo": "page"
}
```

The only addition is `photoUrl: string | null`. Prefer Google's primary
non-default photo; otherwise use its first usable non-default photo. Missing
photos, default placeholders, malformed or non-HTTPS URLs yield null if there is
no usable alternative. All pagination, page-local search, selection/preferences,
phone/email fields and authorization are unchanged. Older backends may omit the
field: handle `null` and `undefined` identically.

## Display safely

Render inside the signed-in owner's private interface only. For example, in
React:

```jsx
{contact.photoUrl ? (
  <img
    src={contact.photoUrl}
    alt=""
    width={40}
    height={40}
    loading="lazy"
    decoding="async"
    referrerPolicy="no-referrer"
    onError={event => { event.currentTarget.hidden = true; }}
  />
) : null}
```

Keep a neutral avatar/initials visible underneath as the null/error fallback.
If reusing an image element for a new URL, reset its hidden/error state.
Do not inject the URL into HTML strings. Permit only HTTPS photo origins needed
in your `img-src` Content Security Policy (Google commonly uses
`https://lh3.googleusercontent.com`); do not loosen the entire policy.
No `crossOrigin` attribute is required just to display an image. Canvas access
would have separate provider CORS requirements and is not part of this change.

Never append Google access tokens, backend credentials or session tokens to the
image URL. A normal `<img>` cannot attach the backend's authorization header.
If Google declines an image request, show the fallback rather than bypassing
authorization or creating a public image proxy.

The private API controls who can discover photo URLs; Google controls access to
the image bytes at its own URLs. This change does not alter Google's photo
visibility or provide a new public photo endpoint. Direct image display contacts
Google's image host, and image caching/access follows that provider's policy.
Treat URLs as private, changeable display data: do not log them, put them in
analytics/public markup, or persist them in browser storage/service-worker
caches. Clear private contact state on logout. Continue using `resourceName` for
React keys, selections and saved preferences, never the photo URL.

The backend contacts response retains `Cache-Control: private, no-store` and
`Referrer-Policy: no-referrer`; the frontend proxy must preserve those headers
and must not cache/log private responses.
