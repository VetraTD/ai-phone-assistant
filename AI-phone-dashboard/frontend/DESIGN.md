---
name: VetraTD dashboard
description: The signed-in dashboard where a business owner sees what their voice agent did and what still needs them.
colors:
  navy: "#010b29"
  ink-blue: "#0038fd"
  ink-blue-hover: "#002ec3"
  cyan: "#00eafe"
  paper: "#f2f6ff"
  surface: "#ffffff"
  ink: "#010b29"
  muted: "#4f5b78"
  faint: "#5f6a85"
  line: "rgba(1, 11, 41, 0.11)"
  line-soft: "rgba(1, 11, 41, 0.06)"
  tint: "#e7eeff"
  hover: "#f6f8fe"
  green: "#14683a"
  green-bg: "#e4f4ea"
  green-ink: "#0f4a2a"
  amber: "#7f4500"
  amber-bg: "#fff1dc"
  amber-ink: "#5c3300"
  grey-bg: "#edf0f6"
  red: "#a4231a"
  red-bg: "#fdecea"
  on-navy-muted: "#aab6d3"
  disabled-bg: "#dfe4ef"
  switch-off: "#7b859e"
typography:
  display:
    fontFamily: "Fraunces, Georgia, serif"
    fontSize: "36px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "Plus Jakarta Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Plus Jakarta Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1.5
  figure:
    fontFamily: "Plus Jakarta Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    fontFeature: "tnum"
  body:
    fontFamily: "Plus Jakarta Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  body-phone:
    fontFamily: "Plus Jakarta Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Plus Jakarta Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "13.5px"
    fontWeight: 700
    lineHeight: 1.4
rounded:
  block: "8px"
  control: "10px"
  inset: "12px"
  card: "14px"
  dialog: "16px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  page: "32px"
  page-phone: "16px"
components:
  button-primary:
    backgroundColor: "{colors.ink-blue}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.ink-blue-hover}"
  button-quiet:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "44px"
  button-quiet-hover:
    backgroundColor: "{colors.hover}"
  button-disabled:
    backgroundColor: "{colors.disabled-bg}"
    textColor: "{colors.faint}"
  link:
    textColor: "{colors.ink-blue}"
    padding: "0 4px"
    height: "44px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.card}"
  list-row-selected:
    backgroundColor: "{colors.tint}"
  nav-count:
    backgroundColor: "{colors.cyan}"
    textColor: "{colors.navy}"
    rounded: "{rounded.pill}"
    padding: "1px 8px"
  status-needs:
    backgroundColor: "{colors.amber-bg}"
    textColor: "{colors.amber-ink}"
    rounded: "{rounded.inset}"
    padding: "12px 16px"
  status-done:
    backgroundColor: "{colors.green-bg}"
    textColor: "{colors.green-ink}"
    rounded: "{rounded.inset}"
    padding: "12px 16px"
  status-quiet:
    backgroundColor: "{colors.grey-bg}"
    textColor: "{colors.muted}"
    rounded: "{rounded.inset}"
    padding: "12px 16px"
  booking-block:
    backgroundColor: "{colors.tint}"
    textColor: "{colors.ink}"
    rounded: "{rounded.block}"
    padding: "4px 8px"
    height: "44px"
  switch-on:
    backgroundColor: "{colors.ink-blue}"
    rounded: "{rounded.pill}"
    width: "44px"
    height: "26px"
  switch-off:
    backgroundColor: "{colors.switch-off}"
    rounded: "{rounded.pill}"
    width: "44px"
    height: "26px"
---

# Design System: VetraTD dashboard

<!-- Recorded 2026-11-22 from the shipped code on feat/dashboard-overhaul:
     src/shell/tokens.css (the normative token source), shell.css, states.css,
     src/pages/*.css, voice-agent.css's overrides of src/settings/Settings.css.
     Examples use only the synthetic Brightwork Family Dental and the +1 555 /
     +44 7700 900 ranges. -->

## Overview

**Creative North Star: "The Front Desk Ledger"**

The dashboard is the owner's front-desk book: a calm paper page where each call is one written line, led by the time or by what the owner has to do, never by an icon or a chart. A single navy column holds the navigation. The work happens on flat white cards over soft blue paper, and ink blue marks the one thing you can act on or the one place you are. It opens on what needs the owner, and every number and time is set in tabular figures so the columns line up like a ledger.

Density is moderate and readable. Rows run 12 to 16 px tall in padding, body text is 15 px on a desktop and never under 16 px on a phone, and every target is at least 44 px. Phone and desktop are equals. The phone is a rearrangement of the same screens (a bottom tab bar, items on their own screen, actions pinned in reach), not a cut-down version.

There is no decoration. Surfaces are flat with hairline borders. Shadows appear only on things that float over the page (popovers, dialogs, the idle warning, the toast). There are no gradients, no icons in coloured circles and no illustrations. The brand mark is the only gradient on screen.

**Key Characteristics:**
- Navy side column, soft blue paper page, white flat cards with hairline borders.
- Ink blue is the single action and active colour. Cyan appears in exactly two places.
- Amber means "needs you", green means done, and each is always paired with words or a shape.
- Fraunces appears once, in the Home greeting. Everything else is Plus Jakarta Sans.
- Rows lead with a tabular time ("9:05 am") or with words, never with an icon.
- 44 px targets, visible ink-blue focus, and reduced motion is honoured.

## Colors

A cool, nearly monochrome navy-on-paper palette with one saturated blue for action, plus two muted status hues that always carry words.

### Primary
- **Ink Blue** (`ink-blue`): primary buttons, the selected list row's left bar, the phone tab bar's active tab and its bar, the switch when on, today's date pill and the "now" line in the calendar, text links, the "AI" speaker label in a transcript, and every focus outline. Hover darkens it to **Deep Ink Blue** (`ink-blue-hover`). Translucent forms are allowed for structure only: the booking block border (28%), today's calendar column wash (3%), and the field focus halo (16%).
- **Signal Cyan** (`cyan`): only the active navigation item's icon and the Home "needs you" count in the side navigation (navy text on cyan). Also the focus outline inside the navy column, where ink blue cannot be seen.

### Neutral
- **Night Navy** (`navy`): the side navigation, the toast, and (as `ink`) all primary text.
- **Soft Paper** (`paper`): the page behind the cards. It is also used inside cards for recessed areas: the search field, the segmented control's track, the call summary block, and the caller column in Inbox.
- **Surface White** (`surface`): cards, list columns, the Today rail, popovers and dialogs.
- **Muted Ink** (`muted`): secondary text such as descriptions, metadata, group headings and empty states. **Faint Ink** (`faint`) is used for the quietest text (list timestamps, hour labels, inactive tabs, disabled button text).
- **Hairline** (`line`, 11% navy): borders between columns, quiet button borders, popover borders and the tab bar's top edge. **Soft Hairline** (`line-soft`, 6% navy): card borders and dividers between rows.
- **Selected Tint** (`tint`): the background of the selected list row and of calendar booking blocks. **Hover Wash** (`hover`): row and quiet-button hover.
- **On-navy Muted** (`on-navy-muted`): the business name and inactive navigation labels in the navy column.

### Status
- **Needs-you Amber** (`amber` text, `amber-bg` fill, `amber-ink` for text on the fill): the action line above a caller's name ("Call back after 3 pm", "Read their message"), the Inbox status banner for open items, and the calendar email warning.
- **Done Green** (`green`, `green-bg`, `green-ink`): the Inbox list's done line, the "what it did" tick marks, the done status banner, and "Copied" confirmations.
- **Quiet Grey** (`grey-bg`): the status banner for calls that need nothing. It is also the dark stripe of the cancelled hatch.
- **Error Red** (`red`, `red-bg`): inline errors, the word "Cancelled" in the booking popover, and settings warnings.

### Named Rules
**The Two Places Rule.** Cyan appears only on the active navigation icon and the Home count. It is never used for text on white, buttons, charts or decoration.

**The Never Colour Alone Rule.** Every colour signal has a second carrier. Amber and green lines are words. The active tab adds weight and a 3 px bar. The selected row adds a 3 px left bar. Cancelled adds a strike-through, a hatch and the word. The switch's state is also in its label.

**The One Series Rule.** Charts in Call trends plot one series in ink blue on a hairline baseline. Their text stays in the text inks.

## Typography

**Display Font:** Fraunces (with Georgia, serif). Self-hosted.
**Body Font:** Plus Jakarta Sans (with system-ui, -apple-system, Segoe UI, sans-serif). Self-hosted.

**Character:** a single warm serif greeting sits on top of a clean, friendly geometric sans that does all the work. The serif says hello, and the sans tells you what happened.

### Hierarchy
- **Display** (Fraunces 600, 36 px, 30 px on phones, line-height 1.1): only the Home greeting ("Good evening").
- **Headline** (700, 22 to 26 px, line-height 1.2): page titles and the open call's caller name. The shipped sizes are Inbox 22 px, Voice agent and the call header 24 px, Calendar and Call trends 26 px.
- **Title** (700, 15 to 17 px): section headings ("Needs you", "Done today"), card titles and the Today rail heading. A muted count often sits beside the title at 14 px.
- **Figure** (700, 26 to 28 px, tabular): the headline numbers on usage and trends tiles.
- **Body** (400 to 600, 15 px, line-height 1.5; 16 px on phones): everything else. Names are 600. Prose blocks are capped at 62ch.
- **Label** (600 to 700, 12 to 14 px): list group headings ("Today", "Voice & greeting"), the amber or green action line, list times, the transcript speaker, tab bar labels (12 px) and count pills. Labels are sentence case and never uppercase or letter-spaced.

### Named Rules
**The One Greeting Rule.** Fraunces is used only for the Home greeting. A new page title is Plus Jakarta Sans 700.

**The Ledger Figures Rule.** Every time, count and figure is set in tabular figures (the `vt-num` class) so the columns line up.

**The Sixteen Floor Rule.** At 760 px and below, no readable text is smaller than 16 px. That includes the reused settings parts inside the Voice agent and Settings panels. The only exceptions are the tab bar labels and count pills, which are short labels attached to an icon.

## Layout

**Shell.** On a desktop there is a 216 px sticky navy side column (brand, business name, then Home, Inbox, Calendar and Voice agent, with Settings pinned to the foot) beside a fluid content column. At 760 px and below, the side column disappears and a fixed bottom tab bar takes its place. The tab bar is 97% white with a hairline top border, has 5 equal columns (4 when there is no Calendar), uses short labels ("Agent"), and leaves 72 px plus the safe area of room at the foot of every page. Calendar appears only when bookings are kept in VetraTD's own calendar.

**Breakpoints.** 760 px is the phone breakpoint for every page. Home moves its Today rail under the list below 1100 px. Inbox adds its third column at 1180 px and above.

**Page patterns.**
- **Home:** a list column (padding 36 by 44 px) beside a 320 px white Today rail with a hairline left edge. On phones the rail becomes one more inset card.
- **Inbox, three columns:** a 340 px sticky call list, the open call, and a 280 px caller column on paper. Below 1180 px the caller column drops under the call. On phones the list and the call are separate screens, and Call back and Done are pinned in a bar above the tab bar.
- **List and panel (Voice agent and Settings):** a full-width header, a 300 px white list of grouped items with muted group headings, and a panel capped at 820 px. The draft save bar sits under the panel. On phones the list is one screen and the chosen item is its own screen with a "back to the list" link.
- **Calendar:** a week grid (56 px hour gutter, 60 px per hour, 8 am to 6 pm, Monday to Saturday) when the page itself is wider than 760 px, or a seven-day strip with the chosen day's list when it is narrower. The width is measured on the page's own box with a ResizeObserver, not the window. Bookings outside 8 am to 6 pm are listed under the grid, never dropped.
- **Call trends:** capped at 1120 px, with auto-fit tiles (minimum 140 px) and then a 2:1 chart grid.

**Spacing rhythm.** All values are pixels with no spacing variables. Gaps step 4, 8, 12 and 16. List rows are padded 12 to 16 px vertically and 18 to 20 px horizontally. Sections are 24 to 28 px apart. Page gutters are 28 to 32 px on a desktop and 16 px on phones.

## Elevation & Depth

The system is flat. Depth comes from tone (paper behind white, white behind a paper recess) and from 1 px hairlines. Cards, list columns, rails and tiles have no shadow. The only shadow belongs to things that float above the page and must be told apart from it.

### Shadow Vocabulary
- **Pop** (`box-shadow: 0 12px 32px -12px rgba(1, 11, 41, 0.35)`): the booking popover and phone panel, the confirmation dialog, the idle sign-out warning and the toast.
- **Inset hairline** (`box-shadow: inset 0 0 0 1px` with `line`, or with `ink-blue` for the chosen strip day): a drawn edge that does not lift anything. It is used for the pressed segment and the selected calendar day.
- **Field halo** (`box-shadow: 0 0 0 3px rgba(0, 56, 253, 0.16)`): settings fields on focus inside Voice agent and Settings, together with an ink-blue border.

### Named Rules
**The Only Floaters Cast Shadows Rule.** A shadow means the thing floats over the page and can be dismissed. Nothing at rest casts a shadow.

**The Dim Backdrop Rule.** Modal dialogs sit on a 45% navy backdrop (`rgba(1, 11, 41, 0.45)`).

## Shapes

There is one radius per element type, defined in `tokens.css`. **Control** (10 px) covers buttons, inputs, selects, the search field, the segmented control, navigation items and calendar strip days. **Card** (14 px) covers cards, tiles, the calendar grid, state cards and settings panels. **Dialog** (16 px) covers popovers, dialogs, the save bar, the idle warning and the toast. **Pill** covers counts, the switch and today's date. Two shipped secondary radii are also used. **Inset** (12 px) is for blocks inside a card: the status banner, the call summary and the booking reference. **Block** (8 px) is for calendar booking blocks and the segmented control's inner buttons.

The selected list row uses a square 3 px ink-blue left border, and the active phone tab uses a 3 px bar with rounded lower corners. Cancelled bookings use a 135° hatch of grey and white in 5 px stripes. This hatch is a state marker, not decoration.

## Components

### Buttons
- **Shape:** control radius (10 px), at least 44 px tall, 16 px side padding, weight 600, 15 px (16 px on phones). An icon may sit at an 8 px gap.
- **Primary:** ink blue with white text. Use it for the main action in a place ("Call back", "Save"). Hover changes it to Deep Ink Blue with a 0.15 s colour transition and no lift.
- **Quiet:** white with a hairline border and ink text ("Done", "Discard", calendar arrows). Hover changes it to the hover wash.
- **Disabled:** a grey fill with faint text and a not-allowed cursor. While the draft is saving, the save bar uses `aria-disabled` instead.
- **Link:** a borderless ink-blue weight-600 text button with a 44 px target ("See call trends", "Copy number", "Reopen"). It is underlined on hover.

### Navigation
- **Side column:** items are 44 px tall with a 12 px icon gap, 14.5 px weight 500 text, and on-navy-muted labels with grey-blue icons. Hover adds a 5% white wash. The active item (`aria-current="page"`) gets a 9% white wash, white text and a cyan icon. The Home count is a cyan pill with navy text. Focus inside the column is cyan.
- **Phone tab bar:** each tab is 52 px tall with the icon over a 12 px label. The active tab is ink blue at weight 700 with a 3 px bar on top. Counts are ink-blue pills.
- **Icons:** five solid icons drawn for VetraTD (house, tray, calendar, sound wave, sliders). They are never placed in coloured circles.

### Lists and rows
- Rows lead with the time (88 px column on Home, 76 px in the Today rail) or with the caller's name. A row has a weight-600 name, an optional amber or green action line above it, and a muted line below it. Dividers between rows are soft hairlines.
- **Selected row:** tint fill plus a 3 px ink-blue left bar. **Hover:** hover wash, or an underline on the name.
- On phones a Home "needs you" row stacks, and its actions become two equal-width buttons.

### Status banner
A block with the inset radius, weight 600, and an icon paired with words. **Needs you** is amber on amber-bg, **Done** is green on green-bg, and **Nothing needed** is muted on grey-bg.

### Cards / Containers
- **Corner Style:** card radius (14 px).
- **Background:** white on paper. Recesses inside a card use paper.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Border:** a 1 px soft hairline.
- **Internal Padding:** 14 to 18 px for tiles and cards, 22 by 20 px for empty states.

### Inputs / Fields
- **Search:** a paper fill with no border, the control radius and a 44 px input. Focus puts the ink-blue focus outline on the whole field.
- **Selects:** a white fill with a hairline border, the control radius and 44 px height.
- **Settings fields (inside Voice agent and Settings):** the settings parts take the dashboard's look through scoped overrides. Panels have no elevation and use the card radius, the accent maps to ink blue, and borders map to the hairline. Focus gives an ink-blue border plus the field halo.
- **Segmented control:** a paper track with 3 px padding. The pressed option is white with an inset hairline and ink text. Options are 44 px tall.
- **Switch:** 44 by 26 px. It is grey (`switch-off`, which keeps 3:1 contrast against white) when off and ink blue when on, with a 20 px white knob that slides 18 px. It has `role="switch"`, a 44 px touch area, and its state is repeated in the row's label.

### Draft save bar
This is used on pages whose settings share one draft (Voice agent, Settings). It is a white bar with the dialog radius and a hairline border and no shadow. It sticks 16 px from the bottom (above the tab bar on phones) and is capped at 764 px. It shows a polite live message ("2 unsaved changes", "Saved") on the left and Discard (quiet) and Save (primary) on the right. Save reads "Saving…" while it is busy. The bar is hidden when there is nothing to say, and it sits outside the item panel so it also shows on a phone's list screen.

### Calendar booking (signature component)
- **Block:** tint fill, a 28% ink-blue border, the block radius and a minimum height of 44 px. It shows a 12.5 px bold time above a name that is cut off with an ellipsis. Overlapping bookings share the column in side-by-side lanes. Hover makes the fill a slightly stronger tint. While its detail is open, the block has a 2 px ink-blue outline.
- **Cancelled:** the name and time are struck through, the block is hatched grey and white, the text is muted and the word "Cancelled" is shown. The popover also says "Cancelled" in red. Its accessible name ends in ", cancelled".
- **Detail:** on a desktop it is a 320 px white popover (dialog radius, hairline border, pop shadow) placed next to the block. On phones it is a panel pinned across the bottom above the tab bar. It shows the day and time, the name, the phone number as a link, notes, the call it came from, and a close action.
- **Now line:** a 2 px ink-blue rule with a 10 px dot. It is the same line as the "Now" marker in Home's Today rail.

### States
Full-screen states (checking sign-in, loading, could not load) use a 440 px white state card on paper: a 19 px bold title, muted text and wrapped actions. Errors are given in plain words next to the thing that failed, in red weight 600. The idle sign-out warning floats at the top as a dialog-radius bar with the pop shadow.

### Words on screen
- **UK English**, plain and direct, in short sentences that say exactly what happens ("Saved changes apply from the next call.").
- **Never shown:** "capabilities", "webhook", "intake", the "says / knows / does" grouping, and "receptionist". The agent is "VetraTD" or "the voice agent". Groups are "Voice & greeting", "Business info" and "Actions". Tests check for these words on Voice agent and Call trends.
- **Times:** "9:05 am" (lower-case am/pm with a space, on the business's own clock, not the viewer's). Whole hours are "9 am", "noon" and "midnight". Ranges use an en dash: "8 am–6 pm".
- **Days:** "Fri 20 Nov" above the time for an item from an earlier day. Day headings are "Today", "Yesterday" or "Tuesday 24 November".
- **Phone numbers:** grouped as people read them, for example "+44 7700 900123" or "+1 (555) 019-9001". A hidden number is "Withheld number".
- **Action lines** lead with the verb and talk about the caller ("Call back after 3 pm", "Read their message").

## Do's and Don'ts

### Do:
- **Do** use ink blue for the single primary action in a place, the active or selected state, links and focus. Use the quiet button for everything else.
- **Do** pair every status colour with words or a shape: the amber action line, the 3 px selected bar, and the strike-through, hatch and word for a cancelled booking.
- **Do** lead list rows with a tabular time or with words, and set every time, count and figure with tabular figures.
- **Do** use the four radius tokens by element type: control 10 px, card 14 px, dialog 16 px, pill. Use inset 12 px and block 8 px only inside a card.
- **Do** keep every interactive target at least 44 px. Extend small controls with an invisible hit area, as the switch does.
- **Do** show focus as a 2 px ink-blue outline with a 2 px offset, and use cyan (or white on the skip link) on navy.
- **Do** make readable text at least 16 px at 760 px and below, including the reused settings parts.
- **Do** measure a component's own width when its layout depends on room (the Calendar grid versus the day strip), not the window's.
- **Do** honour `prefers-reduced-motion`. Under it, transitions and animations collapse to 0.01 ms. Motion is limited to 0.15 s colour and knob transitions.

### Don't:
- **Don't** use cyan anywhere except the active navigation icon and the Home count (and the focus outline on navy).
- **Don't** add shadows to cards, rows, tiles or bars at rest. Shadows are only for popovers, dialogs, the idle warning and the toast.
- **Don't** use gradients, icons in coloured circles, uppercase or letter-spaced labels, or decorative illustration. The only gradients are the brand mark and the cancelled hatch, which is a state marker.
- **Don't** use Fraunces anywhere but the Home greeting.
- **Don't** show "capabilities", "webhook", "intake", "says/knows/does" or "receptionist" in the interface.
- **Don't** show phone numbers ungrouped, or times as "09:05" or "9:05 AM".
- **Don't** use real client names, numbers or call content in examples. Use Brightwork Family Dental and the +1 555 / +44 7700 900 ranges.
