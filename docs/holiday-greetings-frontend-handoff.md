# Copy-and-paste handoff for Who Call Paul

The private Holiday Greetings backend is implemented but **not deployed or
Google-connected**. Its six additive tables were prepared in managed development
only. Nothing was changed in production or in Pray Over Us subscription behavior.

Please integrate the frontend against `docs/holiday-greetings-api.md` from the
backend project. Do not send messages or publish without approval.

Key contracts:

1. Proxy `/api/holiday-greetings/*` same-origin. This is **not** the old client-side
   username/password gate. Shared proxy credentials cannot grant owner access.
2. Forward the `__Host-hg-session` Secure/HttpOnly/SameSite=Lax cookie, CSRF headers,
   genuine Origin, OAuth query parameters, statuses and approved Set-Cookie.
   Never log private bodies, callback queries, cookies or tokens.
3. `GET /session` returns bootstrap/owner state plus `csrfToken`.
   `GET /oauth/google/start` with the CSRF header returns `authorizationUrl`.
   Navigate there. Google callback is exactly:
   `https://who-call-paul.replit.app/api/holiday-greetings/oauth/google/callback`.
4. The callback proxy must not follow redirects internally. Pass its 303,
   Location and rotated cookie to Chrome, then refetch `/session` for new CSRF.
5. Authenticated endpoints: GET contacts/preferences/current batch/by-ID batch;
   PUT preferences; POST/PATCH/DELETE batches; PATCH draft; POST opened/mark-sent;
   POST logout/disconnect. See full contract for exact bodies.
6. Preserve all contact phone choices and stable Google resourceName identifiers.
   Search filters a Google page: keep following nextPageToken, even if a filtered
   page is empty. Never infer missing country codes or replace a saved number.
7. Recipient selection is explicit. Ask/default occasion preferences require
   `confirmedForOccasion: true`; opt-out is enforced. Preferences have versions.
8. Every batch/draft mutation supplies the current **batch version**. A 409 needs
   reload/conflict resolution, not blind overwrite.
9. Before leaving for Messages, POST `/batches/:batchId/drafts/:draftId/opened`
   with current version and final edits/number/queue. Wait for success, then use
   the returned `handoff` for a one-recipient native composition link.
10. Opening/returning does **not** mean sent. Only explicit confirmation calls
    `/mark-sent` with `{ "version": <current>, "confirmed": true }`.
11. Restore from server `/batches/current` on reload/return. Do not use browser
    localStorage/sessionStorage for contacts, drafts or durable queue progress.
12. Handle 401 owner re-login, 403 CSRF/owner rejection, 409 reconnect/conflict,
    429 quota retry, and 503 setup/provider/schema availability distinctly.

Google setup and backend config are still required. This uses owner-only
application OAuth with openid/email/contacts.readonly, not Gmail or contact-write
access. External Testing refresh consent can expire in seven days.

Please report what is actually connected/tested versus mocked. Native Messages
handoff, existing-conversation matching, SIM selection and return-to-queue still
require Android Chrome device testing. Never claim sending or delivery is known.
