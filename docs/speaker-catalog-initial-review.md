# Initial delivered-catalog reconciliation review

This is a **read-only preview of the current production data**, not a claim
that production cleanup has already run. It will be applied transactionally
after the user publishes the additive schema and new code.

## Verified cleanup

- Preserve `ai_career_search`, rename **AI Career Search & ATS Optimization**
  to **AI & the Modern Career**, and use the exact replacement description
  requested. Keep the former title as an internal alias.
- Link the completed November 17 RCNJ AI career webinar to that topic.
- Unpublish and archive, without deleting:
  - `no_code_app_building`: No-Code App Building.
  - `parents_guide_ai_safety`: The Parent's Guide to AI Safety.
  - `parents_guide_ai_homework`: The Parent's Guide to AI Homework Companions.
- The stored `week_of_respect_franklin` public offering contains a school name.
  Change only its reusable catalog copy to **Week of Respect Presentation**
  with **An engaging presentation promoting kindness, inclusion, and positive
  communication among students.** Preserve its stable ID, original title
  alias, and all historical delivery records.

## Conservative matching result

Of **35 existing public completed workshops**, **7 deliveries** can be linked
without guessing, representing **6 unique catalog offerings**:

| Completed workshop title | Offering ID |
|---|---|
| AI & The Modern Career: Navigating Hiring Tech and Elevating Your Search | `ai_career_search` |
| Find Your Voice / Speak So Others Will Listen | `find_your_voice` |
| Speak So Others Will Listen | `find_your_voice` |
| Mastering the 30-Second Elevator Speech for Networking Success | `elevator_speech` |
| Think on Your Feet | `think_on_your_feet` |
| Telling Tales: The Art of Storytelling | `storytelling` |
| The Future of School Leadership with AI | `ai_school_leadership` |

The other 28 historical records remain intact and public in the résumé
history, but are not used as catalog evidence until an explicit mapping or
new reusable topic is provided. Existing offerings without verified links
will stop appearing in the public catalog. They are not deleted or
automatically archived.

This deliberately avoids assuming that a series part proves the full
series, that two related subjects are interchangeable, or that a title naming
only a client identifies a reusable offering.

## Records needing an editor decision

These are unmatched rather than conflicting exact aliases. Select an existing
offering, select several offerings for a combined delivery, or provide a new
client-neutral title/description/category in the same workshop save.

1. AI and Google Docs Training: Brookdale JOBS Program.
2. De-escalation & Diplomacy Under Pressure.
3. Embracing the Future, Honoring Our Humanity.
4. Effective Public Speaking Skills.
5. Active Listening & Communication Skills.
6. Young Speakers Academy.
7. The Future of Thinking.
8. Securing the Future.
9. A Look Under the Hood.
10. Guest Speaker at Matawan-Aberdeen Chamber of Commerce.
11. AI in Your Daily Life.
12. The Building Blocks of AI.
13. Big Brothers Big Sisters (January 16, 2026).
14. Big Brothers Big Sisters (October 10, 2025).
15. Teen Talk: Mastering Public Speaking for Success In-Person.
16. Career Day at Indian Hill (May 29, 2026).
17. Career Day at Indian Hill (May 30, 2025).
18. Find Your Voice with Paul Ireifej '07.
19. AI for Beginners Workshop - Red Bank.
20. AI Program with Paul Ireifej - Matawan.
21. Find Your Voice - Red Bank.
22. Find Your Voice - Matawan.
23. Week of Respect - Franklin School.
24. Master the Art of Public Speaking - Bell Works.
25. Youth Leadership Program - Coordinator.
26. Career Day.
27. Youth Leadership Program - Guest.
28. Master the Art of Public Speaking - Matawan.

After publication, the authenticated
`GET /api/speaker-menu/catalog-review` endpoint gives the current list with
permanent résumé entry IDs. The development database has 33 older workshop
records and therefore its local baseline report differs from the live
35-record preview above. Development data is never copied over production.
