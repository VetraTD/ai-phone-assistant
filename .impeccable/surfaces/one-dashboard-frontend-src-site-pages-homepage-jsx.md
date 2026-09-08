---
version: 1
slug: "one-dashboard-frontend-src-site-pages-homepage-jsx"
primary_target: "AI-phone-dashboard/frontend/src/site/pages/HomePage.jsx"
related_targets: ["AI-phone-dashboard/frontend/src/site/components/CallPlayer.jsx","AI-phone-dashboard/frontend/src/site/components/DiaryPage.jsx"]
---

# Surface brief — Home (vetratd.com/)

Scope: the marketing home page. Visitor mode: Persuade. Audience: owners and practice/office managers of UK small businesses who miss calls while working. Job: understand what Vetra does on a call, hear it happen, and request access. Proof: the real recorded demo call with its word-timed transcript. Constraints: pinned palette (no gradient), Fraunces 600 + Plus Jakarta Sans, UK English, no price, no demo number, one CTA "Request access", six FAQs, real mobile menu, footer ≥280px.

## Direction contract

THESIS: The site is the practice's appointments diary. Every section is a ruled day-page with a time margin, and the hero shows the call writing itself into today's page. It refuses the category's headline-plus-phone-mockup-plus-three-cards arrangement.

OWN-WORLD: White ruled pages on pale-blue paper, hairlines every 44px for hourly slots and every 28px for lined text, a narrow tabular-numeral margin on the left, ink entries in Plus Jakarta Sans, Fraunces 600 for the page's date-scale headings and for anything "written in" by hand, one blue button, teal only as the live marker on the word being spoken and the slot being filled. No cards on cards, no icons as decoration.

STORY: A visitor hears a real after-hours call, watches the 14:00 slot fill in when the receptionist books it, reads what the summary would say, and understands set-up as three diary days ending "live". They request access.

FIRST VIEWPORT: Headline top-left, two lines in Fraunces ("Answers your phone. Keeps your diary."), one lead sentence, the blue button. Below the copy: the transcript page (speaker margin, words lighting as spoken, scrubber on the bottom rule). Right column, spanning from the headline's top: today's diary page ("Friday 5 June", 08:00–18:00 hourly slots, the 14:00 slot outlined when availability is offered and written in when booked), ending with a Notes block that owns the page's remaining rules and states the day is closed from 18:00. Stacked on mobile, headline then player then diary (12:00–16:00 window).

FORM: The Appointments Diary, position 1 on the ordered list of seven; seed 9b06ac59 assigned position 3 (The Reception Sign) in a degraded roll with no challengers; the owner chose the pick card on the decision page. Code-led.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Unresolved

About page content (owner supplies). Whether the demo number returns (constant is null).
