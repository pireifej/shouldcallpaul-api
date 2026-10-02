---
name: Prayer Walk temporary access
description: Temporary subscription exception approved for Prayer Walk audio while IAP is pending.
---

Prayer Walk audio is temporarily available to all signed-in users while mobile in-app purchases are pending. Keep app authentication and signed-user session verification, including identity mismatch rejection. Extended prayer generation remains Pro-only.

**Why:** The user explicitly chose to temporarily unlock Prayer Walk audio after production requests were blocked by the subscription check.

**How to apply:** Preserve the audio exception on both legacy and stream routes. Do not grant local Pro status or unlock other subscription features. Revisit the audio access policy when IAP is ready rather than automatically restoring the gate.