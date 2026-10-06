# Screen-reader test script (30 minutes)

A manual pass on real assistive technology for the one thing automation cannot judge: what a screen reader actually says. Run it against the demo app in `examples/a11y-demo`, deployed as a throwaway Worker (`cf-lite-a11y-demo`); open `<demo-url>` below. Record results in the Result column and file anything that fails as an issue titled `a11y: <step> <screen reader + browser>`.

Status: **no screen-reader pass is recorded yet** ([a11y.md](a11y.md) lists this as still manual). Fill in the table, then update that page with date, tools and versions.

## Already covered by automation (do not retest)

From [a11y.md](a11y.md): axe-core (WCAG 2.0-2.2 A/AA, fails on serious+) on every docs-site page in light and dark; per adapter, after a client navigation (link click, keyboard, browser Back) exactly one polite `#cf-lite-announcer` whose text equals `document.title`, focus on `<main>`, scroll at top, swapped view axe-clean; Firefox 155 run of the browser suite 65/65. So colour contrast, missing labels, ARIA validity and the announcer's DOM contract are known good. This script only checks the spoken result and the judgement calls (is the order sensible, is the message understandable, is anything announced twice).

## Setup

| Combination | Start | Stop |
|---|---|---|
| NVDA + Firefox (Windows) | install NVDA from <https://www.nvaccess.org>, `Ctrl+Alt+N` | `Insert+Q`, Enter |
| NVDA + Chrome (Windows) | same | same |
| VoiceOver + Safari (iPhone) | Settings > Accessibility > VoiceOver, or triple-click the side button | same |
| VoiceOver + Safari (Mac) | `Cmd+F5` | `Cmd+F5` |

Run Part A in one NVDA browser (30 minutes total if you do only that); repeat the starred steps (*) in the second browser and on VoiceOver if time allows. Use headphones; set speech rate to what you normally use. NVDA keys below assume the default desktop layout (`Insert` is the NVDA key). VoiceOver on iPhone: swipe right/left to move, double-tap to activate, rotor = rotate two fingers. VoiceOver on Mac: `VO` = `Ctrl+Option`, `VO+Right` to move, `VO+Space` to activate.

Open `<demo-url>`. Wait for the page to finish loading. Nothing you type is sent anywhere.

## Part A: script

| # | Step | What to do | A pass sounds like | Result (pass / fail / note) |
|---|---|---|---|---|
| 1 | Page load | Load the page, let the reader start. | The page title "cf-lite accessibility demo" is spoken, then it can read from the top. No "blank" or "unlabelled" announced. | |
| 2 | Landmarks | NVDA: `D` / `Shift+D` to jump landmarks. VO iPhone: rotor > Landmarks. VO Mac: rotor (`VO+U`) > Landmarks. | You hear, in order: banner, navigation "Main", main, content information (footer). | |
| 3 | Skip link | `Tab` once from the top. Press Enter. | First stop is "Skip to main content, link". After Enter the next arrow/read starts in the main area, not the menu. | |
| 4 | Headings* | NVDA: `H` repeatedly, `1` and `2` for levels. VO: rotor > Headings. | "Accessibility demo, heading level 1", then "What to listen for, heading level 2", then "Where to go next, heading level 2". Exactly one level 1. | |
| 5 | Lists and links | Move to the list under "What to listen for". Then the links. | "List with 3 items", items read plainly. Links say where they go ("Form", "Live list"), never "click here". | |
| 6 | Client route change* | Activate the "Form" link in the navigation. | Within about a second you hear "Form - cf-lite accessibility demo" (the announcer) once, not twice. Reading position is at the top of the new page ("Sign-up form, heading level 1"), not left on the old link. | |
| 7 | Browser Back* | Press `Alt+Left` (iPhone: the back gesture or button). | The Home page title is announced once, focus is on the main content, nothing from the Form page is read. | |
| 8 | Form labels* | Go to Form (step 6 again). Tab to the first field, then the second. | "Name, edit" (or "text field") then "Email, edit". The label is spoken with every field, not just "edit". | |
| 9 | Validation errors* | Leave both fields empty, press Send. | An alert is read immediately: "Please fix 2 errors" with the two messages as a list. Focus is on that message. | |
| 10 | Error links | Move to the first error link, press Enter. | Focus jumps to the Name field and the reader says "Name, edit, invalid entry" plus the message "Name is required." | |
| 11 | Fix and resubmit | Type a name and `a@b`, Send; then a valid email, Send. | First: "Enter an email address like name@example.com." is reachable with the field. Last: "Thanks, the form is valid. Nothing was sent." is read as a status without moving focus. | |
| 12 | Language switch* | Press the "Tiếng Việt" button (it says "pressed" afterwards). Read the heading. | The heading and nav change to Vietnamese and the reader switches to a Vietnamese voice if one is installed (or at least speaks the text without spelling it letter by letter). The "Tiếng Việt" button itself is read in Vietnamese before you press it. Switch back to English. | |
| 13 | Island with live region* | Go to "Live list". Press "Add item" three times. | Each press announces once, politely, e.g. "Item 1 added. Total: 1", "Item 2 added. Total: 2". It does not interrupt the next keystroke and is not read twice. | |
| 14 | Clear and empty state | Press "Clear list". | "List cleared." is announced; the list area now reads "The list is empty." | |
| 15 | Reading order | Read the whole Home page with the reader's read-all (NVDA `Insert+Down`, VO `VO+A`). | The order is logical: title, intro, sections, footer. No visual-only text, no duplicated sentences. | |
| 16 | Zoom and reflow | Browser zoom to 200 %. (iPhone: turn on Large Text.) | Content stays readable, no horizontal scrolling for text, the navigation is still reachable. | |

## What to write down

For every fail: step number, screen reader and version, browser and version, what you heard (a short quote), what you expected. A one-line description is enough. Also note "no Vietnamese voice installed" if step 12 used the fallback.

## After the test

Update [a11y.md](a11y.md) ("Still manual") with the date, tools and outcome; move failures into issues. The demo Worker is persistent but disposable: `bunx wrangler delete --name cf-lite-a11y-demo` removes it.
