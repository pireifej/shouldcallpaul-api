# Initial delivered-catalog reconciliation review

## User-confirmed grouping follow-up

After the editorial pass below, the user clarified that general public speaking
and Find Your Voice / Improv are distinct offerings, full youth programs share
one offering, and all five AI Decoded sessions establish one series offering.

The live catalog now contains **16 offerings**, supported by **34 linked
completed workshop records**:

- General public speaking groups the two Master the Art of Public Speaking
  deliveries, the two Big Brothers Big Sisters workshops, and Effective Public
  Speaking Skills under the existing permanent general-speaking topic.
- Find Your Voice / Improv includes the separate Think on Your Feet delivery.
  Its former standalone topic remains stored with its permanent ID and original
  copy, but is archived rather than advertised as a duplicate offering.
- The single Youth Leadership guest presentation links to the impromptu-speaking
  offering, not to the full youth program.
- Both full youth programs link to the shared youth program offering.
- All five AI Decoded session records link to the single series offering.
- The older Career Day delivery links to the career-day offering. Its original
  description remains unchanged and makes no new claim about AI content.

Only **Active Listening & Communication Skills** remains unlinked. A separate
clarification is also needed on whether the already-linked Find Your Voice
events in Red Bank, Matawan, and the alumni program should remain with improv
or belong with general public speaking. Existing selections for those records
were left untouched pending the answer.

Live assertions verified unchanged historical records and public workshop feed,
all approved links, preserved unselected links, preserved unrelated topics and
manual overrides, no deleted topic records, and a single combined improv offering.
These were content-only API changes, so no republish is required.

## Live editorial follow-up, November 20, 2026

The original six-offering preview below is retained as the initial rollout
record, not the current public catalog count.

The user authorized resolving clear historical links and adding missing
delivered offerings. Changes were applied through the published management
APIs, without a code deployment or schema change.

The public catalog now contains **15 unique offerings** supported by **21
linked completed workshop records**. Added client-neutral offerings:

- De-escalation & Diplomacy Under Pressure, linked to the Monmouth delivery.
- Embracing the Future, Honoring Our Humanity, linked to the completed keynote.
- Practical AI and Google Docs, linked to the Brookdale delivery.

Connected clear historical evidence for AI for Beginners, How Businesses Can
Effectively Use AI, Find Your Voice, Teen Talk, Young Speakers Academy, Week of
Respect, and Career Day Tech & AI Showcases. The remembered exact title for
Career Day at Indian Hill also resolved its earlier identically titled delivery.

Live API assertions verified that all historical workshop content, the public
workshop feed, existing topic copy, and existing hide/archive/publication
overrides stayed unchanged. All selected topics appeared once in the public
catalog. No CRM data or PrayOverUs data was edited.

**14 records remain for grouping decisions**, rather than silently assuming
related material represents the same offering:

- Effective Public Speaking Skills.
- Active Listening & Communication Skills.
- The five AI Decoded sessions.
- The two Big Brothers Big Sisters workshops.
- The two Master the Art of Public Speaking workshops.
- Youth Leadership Program, Coordinator.
- Youth Leadership Program, Guest.
- Career Day, the older record with no specific title.

Questions cover whether the public-speaking variants share an offering,
whether the full youth programs should share an offering, and whether the
delivered AI Decoded material should appear as a series, individual sessions,
or both. The Expo's separate speaking and listening subjects, the one-session
youth guest presentation, and the older career-day record also need a grouping
decision. Conference presentations remain outside the workshop-only evidence
model; no conference history was moved or duplicated.

## Original pre-publication review

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
