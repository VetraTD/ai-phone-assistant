# Outbound EU calling-hours floor

Status: implemented in `lib/outbound/legalFloor.js` (stage 4, S4-5). Research date 2026-09-29.
This is engineering research, not legal advice. Items marked **needs owner/counsel sign-off** are
NOT applied by the software.

## The default

One strict default for all 27 EU member states, applied to every audience (B2C and B2B):

- Monday to Friday only.
- 10:00-13:00 and 14:00-20:00 on the contact's local clock (end times exclusive).
- No Saturday, no Sunday.
- No nationwide public holiday of the number's country.

It is sized to France (décret 2022-1313, in force 2023-03-01: Mon-Fri, 10-13 / 14-20, no holidays,
consumer calls). No stricter rule was found in any member state. The campaign's own `calling_window`
still applies on top (the call must be inside both).

GB and US-mainland floors are unchanged. Every other country code is refused (`no_legal_floor`).

## How it is applied

- Number to country: longest-prefix match on the E.164 digits against the 27 calling codes
  (AT 43, BE 32, BG 359, HR 385, CY 357, CZ 420, DK 45, EE 372, FI 358, FR 33, DE 49, GR 30, HU 36,
  IE 353, IT 39, LV 371, LT 370, LU 352, MT 356, NL 31, PL 48, PT 351, RO 40, SK 421, SI 386, ES 34,
  SE 46). National part must be 6-12 digits or the number is refused as malformed.
- Refused on purpose: neighbours (+350 GI, +354 IS, +355, +373-+383, +387, +389, +423, +298, +299,
  +376 AD, +377 MC, +378 SM, +379 VA), overseas codes of FR/ES/PT/NL (+262, +590, +594, +596, +508,
  +599, +297, +689, +687), and Italian-numbered Vatican (+39 06 698...) and San Marino (+39 0549...)
  ranges.
- Zones: one clock per country, except ES (Europe/Madrid + Atlantic/Canary; Ceuta/Melilla are
  Africa/Ceuta), PT (Europe/Lisbon + Atlantic/Madeira + Atlantic/Azores) and FI (Europe/Helsinki +
  Europe/Mariehamn). With no contact timezone inside the country, the window must hold in EVERY
  zone of the country. A contact timezone inside the country is honoured; one outside it is ignored.
- Holidays: `lib/outbound/euHolidays.json`, nationwide "public" holidays, 2026-2030, checked on the
  local date in each zone. A date outside 2026-2030 is refused (never "no holidays") and logs
  `outbound_holiday_table_stale` at error level (`{country, year}`, at most once a minute per
  country and year). The gate reads that as `no_legal_floor` (never) or `outside_floor`;
  `schedule_callback` refuses the time.
- **Regenerate before the table runs out (before 2030-12-31)**:
  ```
  npm i date-holidays@3.37.0 --prefix <scratch>/dh
  node scripts/outbound/gen-eu-holidays.mjs <scratch>/dh 2026 2035
  ```
  Then raise nothing else: the covered range is read from the JSON. `date-holidays` is not a repo
  dependency. The script self-checks that regional days are absent (DE Epiphany, All Saints, Corpus
  Christi; FR Good Friday) and known national days present, and fails otherwise.
- Attribution: holiday data is CC-BY-3.0, code ISC (`date-holidays`, https://github.com/commenthol/date-holidays).
  The attribution is in the JSON `source` block. Keep it if the data is redistributed.

## Research summary (accessed 2026-09-29; secondary sources unless a link says statute)

| Country | Hours (B2C) | Weekends / holidays | B2B | Consent / register | Sources |
|---|---|---|---|---|---|
| FR | Mon-Fri 10-13 and 14-20 (décret 2022-1313) | Banned / banned | Decree is consumer-only | Opt-in from 2026-08-11 (loi 2025-594); Bloctel ended; 4 calls per 30 days; 60 days no contact after a refusal | legifrance.gouv.fr/jorf/id/JORFTEXT000046421823 ; kohenavocats.fr/2026/09/27/demarchage-telephonique-horaire-numero-affiche-consentement-entreprise-2026/ ; igen.fr/telecoms/2026/07/adieu-bloctel-partir-du-11-aout-le-demarchage-telephonique-devient-interdit-par-principe-157239 |
| IE | 09:00-21:00 Mon-Sat (statutory basis not found in S.I. 336/2011 reg 13) | Sun banned, Sat allowed / banned | Reg 13 opt-in is for natural persons | Fixed line opt-out via NDD; mobile express opt-in | irishstatutebook.ie/eli/2011/si/336/ ; dataprotection.ie NDD FAQ |
| DE | No statutory hours found | none found | B2B needs presumed consent | B2C prior express consent (UWG s.7(2) no.2); s.7a documentation, 5 years | dirkkreuter.com/blog/paragraf-7-uwg ; bundesnetzagentur.de (Telefonwerbung) |
| ES | Mon-Fri 09:00-21:00 (TRLGDCU art. 96.2) | Banned / banned | Consumer-law focused | LGT (Ley 11/2022) art. 66.1.b; Lista Robinson screening | boe.es/buscar/doc.php?id=BOE-A-2007-20555 ; boe.es/buscar/act.php?id=BOE-A-2022-10757 |
| IT | Code of Conduct (2024-09-28): Mon-Fri 09-20, Sat and pre-holiday 10-19 (force for non-signatories unresolved) | Sun banned; holidays banned | RPO covers businesses | RPO screening mandatory | leggioggi.it/telemarketing-selvaggio-codice-condotta-al-via/ ; garanteprivacy.it docweb 9993833 |
| NL | 09-22 Mon-Fri, Sat 10-16 (statute vs code unconfirmed) | Sun banned | Companies need no consent; sole traders need consent from 2026-07-01 | Opt-in for consumers since 2021-07-01 | ictrecht.nl/en/blog/einde-van-de-soft-opt-in-telemarketing-vanaf-1-juli-2026-alleen-nog-met-toestemming ; business.gov.nl |
| BE | No statutory hours found | none found | DNCM applies to B2B | Opt-out today, opt-in bill status unconfirmed; DNCM screening mandatory | dncm.be ; liedekerke.com |
| PT | "Not before 09:00 nor after 22:00" (secondary, uncertain for marketing) | none found | Collective entities via DGC list | Regime unresolved (opt-out vs opt-in) | anacom.pt/render.jsp?contentId=961775 ; cnpd.pt Diretriz 2022/1 |
| Other 19 (AT, BG, HR, CY, CZ, DK, EE, FI, GR, HU, LV, LT, LU, MT, PL, RO, SK, SI, SE) | No statutory hours found (absence from secondary sources only) | none found | mostly consent-based regimes | see sign-off list | leadfeeder/dealfront 27-country guide ; FEDMA 2026-08 report |

## Differs from the default: NOT applied, needs owner/counsel sign-off

These are looser than the default. The software does not use them.

1. IE 09:00-21:00 Mon-Sat (Saturday, 09:00 start, 21:00 end, no lunch gap).
2. ES 09:00-21:00 Mon-Fri (no lunch gap).
3. IT 09:00-20:00 Mon-Fri; Saturday and pre-holiday 10:00-19:00.
4. NL 09:00-22:00 Mon-Fri; Saturday 10:00-16:00.
5. PT 09:00-22:00 (uncertain source).
6. FR: a consumer-requested callback at a stated date and time may fall on a weekend (one law-firm
   summary; not relied on).
7. B2B: DE and NL treat B2B more loosely, IE reg 13 opt-in is for natural persons, the FR decree is
   consumer-only. The default is applied to B2B too.
8. The 19 states with no rule found are looser by omission.
9. Regional public holidays are not blocked, only nationwide ones: DE Länder days (Epiphany, Corpus
   Christi, Assumption, Reformation Day, All Saints), ES autonomous communities, IT patron saints,
   BE community days (11 Jul, 27 Sep), PT municipal holidays, FR Alsace-Moselle (Good Friday, 26 Dec).
   Residual risk: a call on a regional day off is still inside the weekday default.
10. `date-holidays` accuracy varies by country (community-maintained). Sample the table against an
    official calendar before relying on a market.

Rules that cannot be expressed as an hours floor, also **needs owner/counsel sign-off**:

11. FR opt-in since 2026-08-11: provable prior consent (valid one year, withdrawable). Our lead
    sources must be confirmed as consent to telephone contact for this purpose.
12. FR frequency: at most 4 calls per 30 days per professional; 60-day no-contact after a refusal
    (needs a per-number counter, not built).
13. DE B2C express consent and s.7a documentation; B2B presumed consent needs a concrete interest.
14. National registers: ES Lista Robinson, IT RPO, BE DNCM, IE NDD (and mobile opt-in), PT Robinson
    list; NL consent including sole traders from 2026-07-01. No screening is implemented.
15. Open questions: BE opt-in bill, PT consent regime, IT code-of-conduct force for non-signatories,
    statutory basis of the IE and NL hours.
16. Caller-ID display (FR: real number shown; IT: no anonymous numbers).
