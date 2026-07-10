---
name: Prayer notification digest design
description: Why per-prayer owner emails were replaced with a daily digest, and how admin tracking still works
---

Request owners used to get an immediate email every time someone prayed for them. When one enthusiastic user prays for many requests in quick succession (a "prayer marathon"), each affected owner got a burst of emails — this is legitimate activity, not a duplicate-send bug (confirmed via `user_request` timestamps showing distinct request_ids seconds apart). But combined with normal daily traffic, it contributed to inbox fatigue and bounces ("inbox full") from less active Gmail users.

**Decision:** Push notifications still fire immediately per prayer (cheap, expected). Owner emails are now queued into `pending_prayer_notifications` and sent as ONE digest email per owner per day (cron `0 1 * * *` UTC / 9 PM Eastern), only if at least one person prayed for them that day.

**Why:** Keeps the user experience ("someone prayed for me") immediate via push, while preventing inbox flooding via email — the channel most prone to bounce/deliverability problems.

**How to apply:** The admin (programmerpauly@gmail.com) intentionally still gets a separate tracking email on every single prayer event (sent directly in `/prayFor`, bypassing the digest) because they explicitly want per-event visibility — don't fold that into the digest.

There is no real bounce-detection system (Gmail SMTP via Nodemailer doesn't surface bounce webhooks synchronously — bounces just land as replies in the Gmail inbox). `user.email_bounced` exists as a column but nothing sets it automatically; it would need manual/log-based bounce parsing to populate.

Devotional theme repetition (reported as feeling repetitive) was addressed by expanding `DEVOTIONAL_THEMES` in server.js and adding `getAvailableThemePool()`, which excludes themes used in the last ~15 days (queried from `daily_devotional`) before randomly picking — falls back to the full pool if all themes were recently used.
