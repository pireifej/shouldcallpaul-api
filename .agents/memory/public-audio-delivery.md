---
name: Public audio delivery policy
description: The user accepts public Cloudinary audio URLs and wants mobile GUI access control rather than private media storage.
---

Keep existing Cloudinary audio URLs public. Do not privatize media or migrate storage as part of subscription work. Continue generating and saving audio independently of whether the mobile GUI offers playback.

**Why:** The user explicitly chose mobile GUI visibility instead of private Cloudinary delivery and accepts that direct URLs are not a subscription-security boundary.

**How to apply:** Distinguish GUI restrictions, backend feature gates, and direct media access. Explain that hiding playback does not prevent direct URL access. Do not propose private storage as a rollout blocker under this policy.
