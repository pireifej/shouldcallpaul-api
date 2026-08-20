---
name: Interview-prep content separation
description: Durable data-boundary rule for AI interview preparation and user-authored notes.
---

Personal interview-prep notes and AI-generated interview content are separate data domains. An AI refresh or clear operation must update only AI-generated content; a notes edit must update only personal notes. Legacy freeform content is preserved but not used for new writes.

**Why:** Clearing or regenerating AI preparation must never erase the user's personal research, reminders, or notes.

**How to apply:** Use partial API updates with explicit field-presence checks, expose the two dedicated API fields, and avoid compatibility fields that can silently merge or overwrite the two values.