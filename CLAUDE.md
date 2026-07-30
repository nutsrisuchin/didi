# CLAUDE.md

Guidance for Claude Code working in this repo. Sections marked **[Reusable]** describe
patterns that aren't specific to this app — they're worth copying wholesale into any
similar "no-build, vanilla JS + Firebase, hosted on GitHub Pages" project.

## Project snapshot

**Didi Malatang Hub** — a staff timesheet/payroll, ingredient warehouse, and routine
food-safety-style inspection app for **Didi Malatang**, a malatang restaurant. Vanilla HTML/CSS/JS, no
framework, no build step, no `package.json`. Backed by Firebase (Firestore + Auth only — no
Storage, see below). Deployed on GitHub Pages, auto-deploys on push to `main`. This CLAUDE.md and
the repo/title still say "Didi Malatang Hub" for clarity, but the **UI itself now displays just
"Didi Malatang"** (topbar and login gate) — the "Hub" was dropped from user-facing text only.

| File | Purpose |
|---|---|
| `index.html` | Login gate markup, page shell, nav markup |
| `styles.css` | All styling, one file, no preprocessor |
| `app.js` | Everything else — state, views, auth gate, event handling |
| `db.js` | Firebase wrapper: Firestore (state cache + `onSnapshot`), Auth (PIN login) |
| `firebase-config.js` | Firebase project config (safe to commit — not secret) |
| `firestore.rules` | Security rules — paste into the Firebase console manually; nothing in this repo deploys them automatically |

## [Reusable] Architecture pattern: state cache + onSnapshot + optimistic local writes

- One in-memory `state` object holds everything the UI reads (`state.staff`,
  `state.attendance`, `state.warehouseItems`, etc.), plus current-view/nav state
  (`state.view`, `state.currentDate`, ...).
- Each Firestore collection gets a live `onSnapshot` listener (wrapped as `DB.watch(name, cb)`
  in `db.js`) that replaces the relevant array in `state` and calls `render()`. This means
  every connected device sees every other device's changes without polling. Watchers are
  started once, after login, via `startWatchers()` (guarded by a `watchersStarted` flag) —
  not before, since Firestore rules require `request.auth != null` to read anything.
- Writes are optimistic: `upsertLocal(collection, record)` / `removeLocal(collection, id)`
  update `state` immediately so the UI reflects a change before Firestore's own snapshot
  round-trip confirms it — the confirming snapshot then just no-ops over the same data.
- No client-side router. `state.view` is a string; `render()` is a big if/else that calls the
  matching `renderXxx()` function and swaps `#view`'s `innerHTML`. Nav buttons just set
  `state.view` and call `render()` via the generic `nav-*` action prefix in `handleAction`.
- Rendering is "blow away and rebuild": view functions return a full HTML string via template
  literals, `render()` sets `.innerHTML`, then `bindView()` re-attaches event listeners to the
  fresh DOM. There is no diffing/virtual DOM — fine at this app's scale, but means anything
  holding focus (a text input mid-typing) must not be re-rendered on every keystroke. No view
  in this app currently has a live-search-style input, so this hasn't come up yet — if one is
  added, follow the narrow-re-render pattern rather than re-rendering the whole view.
- `render()` also does role-based gating on every call: it forces `state.view` back to
  `'home'` if the current role can't see the active view, and it hides/shows nav buttons via
  each button's `data-role-min` attribute compared against `roleAtLeast()`. This runs on every
  render (not just on login) so a role change pushed from another device takes effect
  immediately without a refresh.

## [Reusable] `data-action` dispatch pattern

- Any element with `data-action="foo"` (plus optional `data-id`, etc.) gets its `.onclick`
  wired in `bindView()` to call `handleAction("foo", el.dataset)`.
- `handleAction` is one big `async function handleAction(action, data) { if (action === ...) ... }`
  — every mutation in the app funnels through here, and every branch re-checks
  `roleAtLeast(...)` itself before writing, even though the UI already hides the triggering
  button for insufficient roles. The UI gating is just UX; `handleAction`'s own check plus the
  Firestore rule are the actual enforcement — treat all three as required, not redundant.
- There's a minimal modal system: `#modal-host` in `index.html`, a sibling of `#app-root` so it
  isn't affected by that element's own `hidden` toggling. `render()` concatenates the output of
  every modal-render function (`renderScheduleModal() + renderStaffEditModal() +
  renderChangePinModal()`) into its `innerHTML` on every render cycle, same as any other view —
  each modal has no separate render loop of its own, it's just driven by its own bit of `state`
  (`state.selectedScheduleCell`, `state.editingStaffId`, `state.showChangePinModal`) like
  everything else. In practice at most one produces real markup at a time (nothing stops more
  than one being open simultaneously in state, but nothing in the UI drives that either).
  `bindView()`'s generic `[data-action]` wiring covers buttons inside any modal automatically
  since it queries the whole document, not just `#view`; the one bit of custom wiring is
  `.modal-backdrop`'s click handler, which fires whatever action its own `data-close-action`
  attribute names (`close-schedule-cell`, `close-staff-edit`, or `close-change-pin`) only when
  `event.target === backdrop` itself (i.e. the darkened area, not a click occurring somewhere
  inside `.modal-card` and bubbling up). **Adding another modal**: give its backdrop a
  `data-close-action`, add its own state field, and append its render function's output alongside
  the others in `render()` — don't hardcode a single close action in the backdrop wiring again,
  that was a real bug caught while adding the second modal (every backdrop click closed the
  schedule-cell modal specifically, regardless of which modal was actually open). Everywhere else
  in the app still renders inline into `#view` with no modal — this exists specifically because a
  31-row schedule grid made "scroll down to an inline editor panel" impractical; don't reach for
  a modal elsewhere without a similarly concrete reason.

## [Reusable] Firebase Auth/Firestore setup pattern

- **No Firebase Storage** — as of late 2024, Firebase requires the paid Blaze plan to create a
  Storage bucket at all (Spark/free projects can no longer provision one), and this project's
  owner opted not to attach a billing method. Item and routine-inspection photos are instead
  downscaled/compressed client-side (`fileToCompressedDataUrl()` in `app.js` — canvas resize to
  a max 640px dimension, JPEG quality 0.6) and stored as a base64 data URL directly on the
  Firestore doc (`imageUrl` / `lastInspectedImageUrl` fields). Firestore caps a document at
  1MiB total, so if a future change needs bigger/higher-fidelity images, that's a real
  constraint to design around (more aggressive compression, or revisit Storage/Blaze), not
  something to silently relax the compression settings past.
- Firestore collections use the app's own uid scheme for most records (`DB.uid(prefix)` →
  `prefix_<timestamp36><random5>`) — except `staff`, see below.
- **`staff` doc IDs are the person's Firebase Auth `uid`, not `DB.uid(...)`.** This is what
  makes the security rules cheap: a rule can check the caller's own role via a single
  `get(/databases/$(db)/documents/staff/$(request.auth.uid))`, no query needed. If a future
  collection needs per-owner rules, prefer this same "doc ID == auth uid" trick over adding an
  `ownerId` field you'd have to query for.
- Auth is per-person PIN, not "real" passwords: each staff member is a real Firebase Auth user
  under a synthetic email derived from their name (`emailForName()` → `slugify()` in `db.js`,
  currently `slugified-name@didi-malatang.local`), with their PIN as the password — a real
  server-side check via Firestore Security Rules, not just a UI gate. `slugify()` first tries a
  plain ASCII slug (lowercased, non-alphanumerics collapsed to `-`); **for names with no ASCII
  letters/digits at all — i.e. any Thai-only name, the normal case for this app — it falls back
  to encoding every character's Unicode code point** (`u-<codepoints in base36>`) rather than the
  literal string `'user'`. The old behavior collapsed *every* all-Thai name to the same `'user'`
  slug/email, so the second Thai-named account ever created would collide with the first and
  fail to create — permanently, once the first was removed, since removing a `staff` doc doesn't
  delete the orphaned Auth login (see below). Don't reintroduce a fallback that isn't unique per
  distinct name.
- **Creating a new staff login without signing out the admin doing the creating**
  (`DB.createStaffAuthAccount` in `db.js`) uses a throwaway *secondary* Firebase App instance
  (`firebase.initializeApp(config, uniqueName)`), calls `createUserWithEmailAndPassword` on
  that instance (which doesn't touch the default app's auth session), grabs the new user's
  `uid`, then tears the secondary app down. This is the standard workaround for "an app with
  no server-side Admin SDK still needs one logged-in user to provision another."
  - Corollary: there is **no way to hard-delete another user's Firebase Auth account from the
    browser** — that requires the Admin SDK (a server, e.g. Cloud Functions), which is out of
    scope for this no-build static-hosted app. "Remove employee/access" in this app therefore
    only deletes the `staff` Firestore doc — the Auth login technically still exists but is
    orphaned (no matching `staff` doc → `ensureStaffDoc` resolves no role → app signs them
    back out immediately with an error). Say this plainly if a user asks to "delete an
    account" — it isn't a full account deletion.
  - **Changing your *own* PIN is a different, much simpler operation than provisioning a new
    account** — no secondary app or Admin SDK needed, since Firebase Auth lets a signed-in user
    update their own password directly (`DB.changePassword(currentPin, newPin)` in `db.js`,
    reachable from the "เปลี่ยน PIN" button in the topbar user-chip, any role). It re-authenticates
    with the current PIN first via `reauthenticateWithCredential` before calling
    `updatePassword` — skipping that step works fine on a fresh login but throws
    `auth/requires-recent-login` on an older session, so don't remove the reauth step to
    "simplify" this even though it looks redundant with `DB.login`.
- One bootstrap **App Owner** account (`owner@didi-malatang.local`, fixed, must be created manually
  in the Firebase console — Authentication → Add user) is trusted unconditionally by both
  `firestore.rules` (`isOwnerEmail()`) and `ensureStaffDoc()` in `app.js`, so the restaurant can
  never get locked out even before any `staff` doc exists. On that account's first login,
  `ensureStaffDoc()` auto-creates its own `staff` doc.
- `firebase.auth.Auth.Persistence.LOCAL` is used so login survives refreshes.

## Role-based access control (four roles)

`App Owner > Admin > Manager > Employee`, ranked in `ROLE_ORDER` (`app.js`) and mirrored in
`roleRank()` (`firestore.rules`). Enforced in three places that must be kept in sync when
changing permissions: `render()`'s nav gating, each `handleAction`/`handleForm` branch's own
`roleAtLeast(...)` check, and `firestore.rules`.

- **App Owner**: everything, including changing anyone's role; can't be removed via the UI
  (`renderAdmin` never renders a delete button for the `App Owner` row, and the rule rejects
  it server-side too).
- **Admin**: manage `staff` (any role except can't touch the App Owner — including **editing** an
  existing member's name/role/employmentType/dailyRate via the Admin page's "แก้ไข" button, which
  opens `renderStaffEditModal()`; the App Owner row never gets this button, mirroring how it
  never gets a delete button either), timesheet, warehouse, checklist, notifications, and the
  `save-staff-edit` handler force-writes `dailyRate: null` whenever `employmentType` is empty
  (mirrors the create-time convention that only paid staff have a rate — see `staff` in the Data
  model section below), which means **typing a rate while leaving ประเภทการจ้างงาน at "ไม่มี" used
  to silently discard it** — a real bug hit when an Employee/Manager account had never had its
  employment type set (e.g. created via this same page's "Add account" form, which also defaults
  that dropdown to "ไม่มี", so an Employee-role account can end up with no employmentType at
  creation). Now guarded: entering a nonzero rate with employmentType still empty shows an alert
  and aborts the save instead of writing `null`. If a staff row on the Admin page is missing its
  "· เต็มเวลา/พาร์ทไทม์ · ฿.../วัน" line entirely, that's the tell — its `employmentType` is `''`,
  fix it by setting employment type and rate together in the same edit, not just the rate alone.
  **Financial section** (`/financial` view, `data-role-min="Admin"` on its nav button plus an
  explicit `render()` gate — see Business logic section below), which is also where **salary/
  `dailyRate` is viewed and edited** — Admin+ only, deliberately narrower than the rest of `staff`
  management Admin otherwise has. Since the Timesheet view reads live from the same `state.staff`
  cache via the same `onSnapshot` watcher as everywhere else, an edit made here shows up in
  Timesheet immediately with no separate sync step — this is just the existing "state cache +
  onSnapshot" architecture, not a new mechanism.
- **Manager**: add/remove `Employee`-role staff (from the Timesheet page's own "Remove
  employee" button, not the Admin page — Managers can't reach `/admin` or `/financial` at all),
  mark attendance, plan the monthly schedule grid (see Business logic section below), manage
  warehouse items, create/manage checklists. Cannot touch Manager/Admin/Owner accounts, and
  **cannot see `dailyRate` or any computed `pay` figure anywhere in the app, not even their own**
  — `renderTimesheet`'s `showSalary = roleAtLeast('Admin') || !canManage` flag hides both from
  the Manager view specifically while still showing it to Admin/Owner and to an Employee viewing
  their own row. The "Add employee" form correspondingly drops its `dailyRate` field entirely
  when the viewer isn't Admin+ (new hires get `dailyRate: 0` until Admin/Owner sets a real rate
  from Financial); this is also enforced server-side (see below), not just hidden in the UI.
- **Employee**: log in, tick off checklist sub-tasks and submit checklist reports. On Timesheet,
  sees a read-only monthly schedule grid **for every paid staff member, not just themselves**
  (`staffList` is the same `state.staff.filter((s) => s.employmentType)` used for Manager+, no
  self-filtering) — so they can see who's on/off, but nothing else: `renderTimesheet`
  early-returns a completely different, much shorter view when `!canManage` with no daily
  quick-mark panel and no editable cells (`renderMonthlySchedule(staffList, false)` renders plain
  `<span>`s instead of buttons). No pay/salary figure is shown here regardless of who's viewing —
  `renderMonthlySchedule` only ever displays clock-in/out times or "หยุด", never `pay`, so there
  was nothing to gate when this view was widened from "just yourself" to "everyone." On
  Warehouse, can update an item's quantity (the "อัปเดต" control next to each item) but cannot
  add, delete, or photo-upload an item — see the Data model section's `warehouseItems` entry.
  Read-only everywhere else.
- A Manager creating a new `staff` doc is restricted server-side to `role in ['Employee',
  'Manager'] && dailyRate == 0` (`firestore.rules`) — without the role split a Manager could
  craft a raw Firestore write to self-promote to Admin/Owner via the same "create" permission
  that lets them add employees; without the `dailyRate == 0` clause a crafted request could set
  an arbitrary rate even though the UI never offers that field to a Manager. Don't relax the
  create rule without re-adding both checks. Similarly, a Manager's `update` on an Employee doc
  is only allowed when `request.resource.data.dailyRate == resource.data.dailyRate` (unchanged)
  — the one field a Manager is otherwise allowed to touch on that doc must not include salary.

## Business logic: schedule, rounding, pay (Didi Malatang-specific)

- Schedule: fixed `09:30–20:30` for every day of the week, no weekday/weekend split (11h span,
  1h unpaid lunch → 10 worked hours baseline). `scheduleFor(date)` in `app.js` — takes a date
  argument for call-site compatibility but the same schedule now applies regardless of the date.
- **Default assumption: every employee works their normal schedule every day of the month,
  past or future, unless a manager explicitly marks that specific day off.** No `attendance`
  record for a given (staff, date) is *not* treated as an unpaid absence — it's the implicit
  "worked, on time" default. This was a deliberate reversal of an earlier version of this app
  (where "no record" meant unpaid/absent for already-elapsed days) after the user found having
  to manually confirm every single normal working day made the monthly schedule grid impractical
  to use. `getAttendanceForDate()` itself is unchanged (still just looks up whatever doc
  exists-or-doesn't); the "assume working" behavior lives in the callers that interpret the
  result — `computeExpectedSalary()`, `renderMonthlySchedule()`, `renderScheduleSummary()` — not
  in the data layer itself.
- Three ways an `attendance` record gets written, all producing the same doc shape:
  - **Quick daily mark** (Timesheet's "ภาพรวมการลงเวลา" section, `mark-attendance` action, itself
    behind a collapsed `<details>`/`<summary>` — `.schedule-daily-summary` in `styles.css` — so
    the per-employee list with its buttons isn't taking up screen space by default on every
    visit): clock-in is rounded up to the next half hour via `roundUpToHalfHour()` — e.g.
    `10:10→10:30`, `10:35→11:00` — and clock-out is always the fixed schedule end. This is for
    tapping "mark present" in the moment someone actually arrives.
  - **Monthly schedule grid, exact-time override** (`save-schedule-cell` action, inside the
    schedule-cell popup — see the modal system note above; both the day-off button and the
    exact-time inputs are visible at once, not behind a further disclosure — an earlier version
    hid the time inputs behind a collapsed `<details>` but the user asked for them always
    visible instead): both clock-in and clock-out are taken from the two time inputs *exactly as
    typed, with no rounding* — for correcting a specific day (e.g. someone came in late), not for
    routine use.
  - **Monthly schedule grid, day-off marker** (`mark-schedule-dayoff` action — the grid's primary,
    one-tap action): writes `dayOff: true` with `clockIn`/`clockOut` null and `pay: 0`. Undoing it
    (`clear-schedule-cell`) simply **deletes** the record, reverting to the implicit "working"
    default — this is the opposite of what deleting an attendance record used to mean in an
    earlier version of this app (previously: no record = day off). Every write from any of the
    three paths explicitly sets `dayOff` (true, or false) rather than leaving it to Firestore's
    merge semantics, since `DB.put` merges rather than overwrites — otherwise a stale `dayOff:
    true` from a prior write could silently survive alongside a fresh clock-in/out.
  - `lateMinutes = max(0, clockIn − scheduledStart)`; `workedHours = max(0, (clockOut − clockIn)
    − 60min)` (quick-mark always uses the fixed schedule end for `clockOut` here; the grid's
    exact-time override uses whatever end time was entered) — `workedHours` is stored for display
    only, it does not feed the pay formula (see below), consistent with "no OT."
  - Every write from any path also stamps `updatedBy` (the acting user's uid) and pushes a
    notification naming who made the change — see the Notifications section below.
- **Every employee — full-time and part-time alike — is paid a custom per-person day rate**
  (`staff.dailyRate`, set when the account is created), not a fixed monthly salary and not a
  shared base amount. `employmentType` (`full-time`/`part-time`) is still selected at creation
  and shown in the UI, but as of this pay model it no longer branches the pay calculation itself
  — both types go through the same formula. This supersedes the previous fixed-440-THB
  part-time formula and the "full-time pay intentionally unimplemented" deferral; do not
  reintroduce either without checking with the user first, since this is now a live payroll
  calculation people are actually paid from.
- Pay formula (`calculateDailyPay(dailyRate, lateMinutes, isHoliday, closingDuty = false)`):
  `max(0, dailyRate × (isHoliday ? 1.5 : 1) − ceil(lateMinutes/60)×40 + (closingDuty ? 50 : 0))`.
  `isHoliday` comes from `isHolidayDate(date)`, which checks the admin-maintained `holidays`
  collection (see Data model below) — there is no per-attendance-record checkbox for marking a
  day as a holiday, it's entirely driven by that date list. `closingDuty` ("ปิดบิลแทน" — closed
  the till that day) is the opposite: it **is** a per-attendance-record flag, toggled from the
  schedule-cell modal's second button (`toggle-closing-duty` action), and the flat +50 THB bonus
  is added *after* the holiday multiplier, not multiplied by it. Every write path that can touch
  an existing record's `closingDuty` (`mark-attendance`, `save-schedule-cell`) explicitly reads
  and re-passes the prior value through — `DB.put` merges rather than overwrites, so silently
  omitting the field on an unrelated edit (e.g. correcting a clock-in time) would otherwise leave
  a stale `closingDuty: true` on the doc without its pay bonus actually being recalculated in.
  `mark-schedule-dayoff` explicitly sets `closingDuty: false` instead (can't be off and closing
  the till the same day).
- **Financial section** (`/financial` view in `app.js`, Admin+ only): shows each paid employee's
  *expected salary for a selected calendar month* (`computeExpectedSalary()`), picked via a
  native `<input type="month">` (small built-in calendar icon — **not verified on iOS Safari**,
  which has historically had inconsistent support for `type="month"`; worth testing on a real
  iPhone before relying on it). For each day of the selected month: a record with `dayOff: true`
  contributes 0; any other record (real clock-in/out, from either the quick mark or the grid)
  contributes its own `pay`; **no record at all still contributes a full on-time day's pay** via
  `calculateDailyPay(dailyRate, 0, isHoliday)` — see the "default assumption" note above. There is
  no past/future distinction any more; the same rule applies uniformly to every day of the month.
- Financial is also where `dailyRate` is edited (`update-employee-rate` action) — a mini-input +
  button per employee row, same convention as the Warehouse quantity editor. Editing pushes a
  notification naming who changed whose rate, same as attendance changes above.

## Notifications: client-triggered, not server-triggered

`pushNotification()` writes directly to the `notifications` collection from whichever
browser tab happens to trigger the event (routine going overdue, staff/item added, etc.).
There is no Cloud Function or scheduled job — this is a static, no-build app, so "run
something server-side on a timer" isn't available without adding a paid/hosted backend piece.
Practical implication: the overdue-routine check (`checkRoutineOverdueNotifications`, tracked
via the in-memory `notifiedOverdueRoutineIds` Set) only fires while some browser tab is open
and connected; if multiple devices are open right as something crosses into "overdue," each
may independently write a duplicate notification. Treat this as a known, accepted limitation
of the no-backend approach rather than a bug to silently "fix" with more client-side
de-duplication — a real fix would mean adding Cloud Functions, which is a bigger, separate
decision.

All attendance-related notifications (quick daily mark, clear, and every monthly schedule grid
save/clear) name the acting user by reading `state.currentStaff.name` at the point of the write
— they do **not** look anything up from `updatedBy` at render time. If accountability for older
notifications matters after `state.currentStaff` is unavailable (e.g. auditing much later), the
per-record `updatedBy` uid on the `attendance` doc itself is the durable source of truth.

## Language

The UI is Thai throughout `index.html` and `app.js` — labels, buttons, headings, placeholders,
status text, and notification titles/details written from here on. **"Didi Malatang Hub" (the
brand name/title) stays in English on purpose** — don't translate it.

Firestore *values* that the app compares against directly stay in English and are translated
only for display, via small label maps in `app.js`:
- `staff.role` (`'App Owner'`/`'Admin'`/`'Manager'`/`'Employee'`) → `roleLabel()` /
  `ROLE_LABEL_TH`. The raw English value is still what `ROLE_ORDER`, `roleAtLeast()`, and
  `firestore.rules`' `roleRank()` compare against — never translate the value itself, only
  wrap it in `roleLabel()` at the point of display. `<option value="Admin">` etc. keep their
  English `value`, only the visible option text is Thai.
- `staff.employmentType` (`'full-time'`/`'part-time'`) → `employmentTypeLabel()` /
  `EMPLOYMENT_TYPE_LABEL_TH`, same rule.
- `getRoutineStatus()`'s return value (`'overdue'`/`'on-track'`, also used as a CSS class name
  via `.badge.overdue`) → `routineStatusLabel()` / `ROUTINE_STATUS_LABEL_TH`.

Notifications (`pushNotification()` calls) are now written in Thai at every call site, but
existing notification docs already in Firestore from before this change remain in English —
they were not retroactively migrated, matching how the `salary`→`dailyRate` and other schema
renames were also handled at the boundary rather than backfilled.

## Theme / color palette

`styles.css` defines the palette as CSS custom properties on `:root` (`--color-primary`,
`--color-gold`, `--color-bg`, etc.), sampled from the Didi Malatang logo (deep red, gold ring,
cream). Use the variables rather than new hardcoded hex values when styling anything new, so a
future palette change stays a one-place edit.

## [Reusable] Mobile / iOS Safari-first design rules

Restaurant staff use this on their phones, so these are checked for every new UI element.

- **Inputs/selects/textareas need `font-size: 16px` or larger** — anything smaller triggers
  iOS Safari's auto-zoom-on-focus on every text field. Enforced globally in `styles.css`
  (`input, select, textarea { font-size: 16px; }`) rather than per-component; keep new input
  styles from overriding it smaller.
- **Tooltips (`title="..."`) don't work on touch devices at all.** Any information conveyed by
  hover must also be a visible caption/label.
- **Any element meant to be tappable needs a real touch target (~44px)**, not just an icon
  sized for a mouse cursor.
- **Test/reason about narrow-viewport layouts (<900px, and again <650px) explicitly** — see the
  two breakpoints already in `styles.css` (`.app-shell` collapses to one column, `.topbar`/
  `.form-grid`/`.user-chip` stack). New multi-column layouts should extend those same media
  queries rather than inventing new breakpoints.
- Elements meant to run fullscreen (PWA/home-screen use) should respect
  `env(safe-area-inset-*)` — see `.login-gate`'s `padding-top`.
- **Home-screen icon** (`manifest.json` + `<link>`/`<meta>` tags in `index.html`'s `<head>`):
  Android/Chrome reads the icon from `manifest.json`'s `icons` array; **iOS Safari ignores that
  entirely** and only looks at `<link rel="apple-touch-icon">` — both are needed, not just one.
  Both currently point at the same `logo.jpg` with no resized variants (no image-processing tool
  was available when this was set up), using `"sizes": "any"` in the manifest rather than a
  specific number like `"192x192"` — declaring an exact size that doesn't match the file's real
  pixel dimensions risks Chrome silently skipping that icon entry for install-eligibility checks.
  If real dimensions are ever confirmed (or multiple actual sizes get generated), prefer adding
  proper `"192x192"`/`"512x512"` entries alongside `"any"` rather than replacing it. This setup
  only makes the home-screen icon/name correct — there's no service worker, so it's not an
  installable offline-capable PWA; don't imply otherwise if asked about "installing the app."
- When genuinely unsure how something behaves on iPhone Safari vs. desktop Chrome (camera
  `capture="environment"` input behavior, viewport height quirks), say so explicitly rather
  than assuming parity. Checklist photo inputs still use
  `<input type="file" accept="image/*" capture="environment">`, worth testing on a real device
  if a bug is reported there. **Warehouse item photo inputs deliberately dropped `capture`** —
  it was forcing the camera open directly on some mobile browsers instead of also offering
  "choose from library," and warehouse items are just as often photographed from an existing
  gallery shot as a fresh one. Don't re-add `capture` to the warehouse inputs without checking
  this reasoning still applies.

## [Reusable] GitHub Pages deployment gotchas

- No build step: pushing to `main` is the deploy. There is no staging environment.
- **The GitHub Pages CDN caches aggressively** — a push can take longer than expected to be
  visible; verify via `curl -sI <url> | grep -Ei 'last-modified|age'` against the live URL
  before assuming a just-shipped fix is broken.
- **Home-screen (standalone) icons cache far more stubbornly than a normal browser tab.** There's
  no service worker in this app (see the manifest note above — it's a bookmark-style shortcut,
  not an installable offline PWA), so staleness here is just the OS webview holding onto the old
  `index.html`/`app.js`/`styles.css` — but a standalone window has no visible reload/refresh
  gesture, so it can keep showing a stale build well past the page's own `Cache-Control: max-age`
  until the app is fully force-quit (swiped away in the app switcher, not just backgrounded) and
  reopened. If a user reports "it works in the browser but not from the home screen icon," that's
  the first thing to have them try — don't assume the deploy itself is broken; confirm with the
  `curl -sI` check above first. `index.html`'s `<link>`/`<script>` tags for `styles.css`, `db.js`,
  `app.js`, and `firebase-config.js` carry a manually-bumped `?v=YYYYMMDD` query string precisely
  so a fresh `index.html` fetch (which does eventually happen, even from a stale home-screen
  session) pulls fresh copies of everything else too rather than serving old cached JS/CSS
  alongside a new HTML shell. **Bump this date string on every push that changes `app.js`,
  `db.js`, or `styles.css`** — it's a manual step (no build tool generates a content hash here),
  and forgetting it silently reintroduces the desync this was added to prevent. It doesn't fully
  solve deep webview caching of `index.html` itself, though — force-close/reopen remains the
  reliable fix for that specific case.
- `firebase-config.js` is safe to commit — none of its values are secret; access control is
  Firestore Security Rules + the PIN auth layer, not hiding this file.
- `firestore.rules` is **not** auto-deployed by anything in this repo (no Firebase CLI/CI wired
  up) — changing it means editing the file here *and* manually pasting the new contents into
  the Firebase console's Rules tab. If asked to change permissions, update both, and say
  explicitly that the console-side paste is a manual step for the user.

## [Reusable] Workflow conventions observed in this project

- **Always `node --check <file>.js` after every edit**, before considering a change done — no
  build step, no CI, so a syntax error would otherwise only surface live in the browser
  console.
- **Every delete action requires confirming twice**, via `confirmDeleteTwice(message)` in
  `app.js` — two separate native `confirm()` prompts in a row, not one. Deletes in this app are
  permanent (no undo, no trash/recycle bin), so this was an explicit user request for more
  friction than the single "are you sure?" pattern most apps use. Applies to `delete-item`,
  `delete-routine`, `delete-staff`, `delete-holiday` — any new delete action added later should
  follow the same pattern, with a message naming the specific thing being deleted (not a generic
  "are you sure?").
- Commits are created only when explicitly asked, generally batched into one commit per
  logical feature, with a message explaining *why* — and pushed only when explicitly asked.
  Don't assume standing permission to push from one instance of "commit and push now."
- This app has no test suite and no browser-automation tool is available in this
  environment — verification is `node --check` (syntax only) plus careful code review. Any
  claim about actual rendered/runtime behavior should say plainly it wasn't visually verified.
  The app also requires a real Firebase project (Firestore + Auth enabled, a bootstrap Owner
  Auth user created) to exercise login/roles at all, which further rules out casual local
  testing until that project exists.
- When a user reports "X doesn't work," prefer asking them to inspect one concrete piece of
  evidence over guessing further from the description alone.

## Data model (Didi Malatang Hub-specific)

Firestore collections: `staff`, `attendance`, `warehouseItems`, `warehouseLogs`, `routines`,
`routineInspections`, `notifications`, `holidays`. No Storage bucket — see the "no Firebase
Storage" note above; images live inline on the docs below as base64 data URLs.

- **`staff`** (doc ID = Auth `uid`): `name`, `role` (`App Owner`/`Admin`/`Manager`/`Employee`),
  `employmentType` (`full-time`/`part-time`/`''` for non-hourly Owner/Admin accounts),
  `dailyRate` (per-employee day rate in THB, set at creation, `null` when `employmentType` is
  `''` — see Business logic section above; this replaced a fixed-monthly `salary` field), `active`,
  `createdAt`. One collection covers both "employee for payroll" and "login account with a
  role" — the Timesheet page's "Add employee" form and the Admin page's "Add account" form both
  write here, just with different allowed `role` values (see RBAC section above).
- **`attendance`** (doc ID = `` `${date}_${staffId}` `` — deterministic, so marking attendance
  twice for the same person/day upserts instead of duplicating): `staffId`, `date`
  (`YYYY-MM-DD`), `dayOff` (bool — see the "default assumption" note above; the absence of a
  whole record, not this field being `false`, is what signals "no explicit data, assume
  working"), `clockIn`, `clockOut` (both `null` when `dayOff` is true), `lateMinutes`,
  `workedHours` (display only, doesn't feed pay), `pay` (computed via `calculateDailyPay`, `0`
  when `dayOff`), `isHoliday` (bool, whether `calculateDailyPay` applied the 1.5x multiplier for
  that date), `closingDuty` (bool, whether this person closed the till that day — a flat +50 THB
  add-on already baked into `pay`; always explicitly `true`/`false` on every write, never left to
  merge-through, see Business logic section above), `updatedBy` (the acting user's Auth uid — set
  by every write path, see Business logic section above), `createdAt`.
- **`warehouseItems`**: `category` (free text — no fixed category list, same convention as
  `unit`; the Warehouse view groups items into collapsible sections by this field, falling
  back to `'อื่นๆ'` when unset), `name`, `unit` (free text — no fixed unit list), `quantity`
  (decimal, e.g. `1.5` for a partially-used pack), `imageUrl` (compressed base64 JPEG data URL,
  or `''` — settable at creation, and separately addable/replaceable later per-item via the
  Warehouse view's "เพิ่มรูป"/"เปลี่ยนรูป" control, `update-item-photo` action), `createdAt`,
  `updatedAt` (stamped on every write path that touches an existing item — quantity update,
  photo update — as well as at creation; items that predate this field fall back to `createdAt`
  wherever it's displayed, via `item.updatedAt || item.createdAt`, rather than showing nothing).
  Each item's card in the Warehouse view shows this as a small muted date (`formatDate`,
  `.stock-updated-at` in `styles.css`) after the ลบ button, so anyone can see at a glance when an
  item was last touched without affecting the row's height — deliberately *not* the same thing as
  the latest `warehouseLogs` entry for that item, which only exists for quantity changes and would
  miss a photo-only update.
  The Warehouse screen has a Manager+-only **`state.warehouseEditMode`** toggle
  ("แก้ไขคลังสินค้า"/"เสร็จสิ้นการแก้ไข") that hides, by default, the "เพิ่มสินค้า" create-item
  form, the one-time stock-sheet import section, and each item's photo-upload control — this was
  a deliberate declutter request; **quantity update stays visible unconditionally to every
  signed-in role, including Employee** (`update-item-quantity` only checks `roleAtLeast('Employee')`
  — effectively "any logged-in staff" — both client-side and in `firestore.rules`, since updating
  the count on hand is a frequent daily task, not a management action), while **delete stays
  Manager+ only** (`canManage`), same as add/photo-upload. This was a deliberate split: Employees
  can correct/update stock counts but cannot add new items, upload item photos, or remove items —
  don't widen delete or add to Employee without checking with the user first, since the ask was
  specifically "update but not add or delete." If asked to also hide/reveal quantity behind the
  edit-mode toggle, or to widen/narrow who can delete, that's a scope change to confirm, not an
  inconsistency to "fix" silently. `update-item-quantity` pushes a notification naming the acting
  user, item, and new quantity (previously this action was the one write path in the whole app
  with no notification at all — every other mutation already had one, see the Notifications
  section below) and wraps its two `DB.put` calls in try/catch: an unhandled rejection here
  (e.g. a permission-denied error from `firestore.rules` not yet being the current version — see
  the GitHub Pages deployment section on `firestore.rules` never auto-deploying) used to fail
  completely silently, since `render()` never ran afterward but the `<input>` still visibly held
  the just-typed number, making a rejected write look locally successful. Now it `alert()`s the
  raw error message and always re-renders to show the true saved value.
- **`warehouseLogs`** (append-only, one doc per quantity snapshot — written whenever an item is
  created, its quantity is updated, the stock-sheet seed imports it, or the stock-history backfill
  runs — see below): `itemId`, `quantity`, `recordedAt`. This is the only history the app keeps of
  stock levels over time; it drives `computeStockInsight(item)`, which mirrors the usage-rate
  methodology the user already used by hand in `stock_data_1.md` — average daily usage is
  `Σ(declines between consecutive logs) / Σ(days over those same declining periods)` (periods
  where quantity went *up*, i.e. a restock, are excluded so they don't read as negative usage),
  reorder point is `usagePerDay × 7 × 1.3`, suggested order quantity is `usagePerDay × 14 −
  currentQuantity`. Needs at least two log entries with an actual decline between them to produce
  a rate — until then `computeStockInsight` returns `{ hasData: false }`.
  - The Warehouse tab's own "Restock priorities" section only surfaces the subset of items
    that's already low/urgent (excluded entirely if `!hasData`, shown as a "not enough data yet"
    count instead). The Home page's "Warehouse health" card (`.card.clickable`,
    `data-action="nav-warehouse"`) navigates straight into this section rather than opening a
    modal — a modal now exists elsewhere in the app (see the modal system note above) but wasn't
    the right fit here, since this is "go look at a whole page of detail," not "edit one small
    thing in place."
  - **`renderWarehouseAnalytics()`** (nav button "วิเคราะห์คลังสินค้า", `state.view ===
    'warehouse-analytics'`) is a separate, dedicated tab that runs `computeStockInsight` over
    *every* item, not just the low/urgent ones — sorted soonest-to-run-out first, `!hasData` items
    last. Visible to every signed-in role, same as the rest of Warehouse (not Manager+ gated) —
    seeing the analysis isn't sensitive, only the backfill button below is gated. Each row shows
    current quantity, usage/day, reorder point, suggested order, and a days-left badge (or "ไม่มี
    ข้อมูล" if `!hasData`).
  - **`STOCK_HISTORY_DATES`/`STOCK_HISTORY_DATA`** (`app.js`, near `STOCK_SEED_DATA`) is a one-time
    backfill dataset transcribed from `stock_data_1.md`'s 32 historical stock-check columns
    (5/4/69–23/7/69 — Thai Buddhist year 69 = 2026 CE — matched to `warehouseItems` by name, `null`
    where the file shows "-"/"—" for an item not yet tracked at that check). The `26/7` column is
    deliberately excluded since it's already the live snapshot captured by
    `STOCK_SEED_DATA`/`import-stock-seed` — backfilling it again would just add a redundant
    zero-decline log. Items with no historical column at all (e.g. น้ำจับเลี้ยง, first seen on
    26/7) have no entry — nothing to backfill. Footnoted values in the source file (mid-period
    restocks, e.g. `80†`) are recorded at their raw post-restock number like any other reading;
    `computeStockInsight`'s existing decline-only logic already skips a period that nets an
    increase because of a mid-period restock, same limitation the user's own by-hand analysis in
    `stock_data_1.md` already accepted — don't try to special-case the footnoted periods to
    recover that "true" usage figure without checking with the user first, since it would mean
    hand-encoding ~15 one-off overrides rather than a uniform rule. The `import-stock-history`
    action (Manager+ only, like `import-stock-seed`) writes one `warehouseLogs` doc per
    non-`null` historical reading. Its guard for "already imported, hide the button" is
    `state.warehouseLogs.some((log) => log.recordedAt < '2026-05-01')` — there's no separate
    flag/document tracking this, same trick `import-stock-seed` uses (checking
    `state.warehouseItems.length === 0`) rather than adding new state just for a one-time gate.
- **`routines`** (user-facing label is "Checklist" throughout the UI — the collection name and
  internal `state.view === 'routines'` were kept as-is to avoid a Firestore-path/rules churn for
  what is otherwise a pure relabel+redesign): `name`, `description` (short free-text summary),
  `detail` (longer free-text instructions), `subtasks` (array of `{id, text}`, parsed from a
  one-line-per-subtask textarea on the create form — no per-definition "done" state, since
  that's re-ticked fresh on every completion), `timeOfDay` (a free `HH:MM` string from an
  `<input type="time">` on the create form, or `''` if left blank — a purely informational tag
  shown as a badge, doesn't affect scheduling/due-status logic at all, just when in the day
  someone's meant to do it. Older routines created before this field became a time picker may
  still hold the original two categorical values, `'before-open'`/`'after-close'` —
  `TIME_OF_DAY_LABEL_TH` translates those specifically for display; any other value (i.e. every
  new `HH:MM` reading) falls through to being shown as-is, which is already the correct display
  for a time string, so no migration of old records was needed), `lastInspectedAt`,
  `lastInspectedImageUrl` (persists across completions — only overwritten when a report attaches
  a new photo), `createdAt`, and **two mutually-exclusive ways to express recurrence**:
  - `frequencyDays` (number) — the original "every N days" model, due when
    `lastInspectedAt + frequencyDays < now`.
  - `weekdays` (array of `Date.getDay()` values, `0`=Sunday…`6`=Saturday) — due starting midnight
    on any selected weekday until completed that same day, not due at all on the other days of
    the week. **When `weekdays` is non-empty it completely overrides `frequencyDays`** — they
    don't combine. `getRoutineStatus()` and `frequencyLabel()` (both in `app.js`) both check
    `weekdays` first and only fall back to the `frequencyDays` calculation when it's absent/empty.
    The create form doesn't dynamically hide either input; it just labels the `frequencyDays`
    field "used when you haven't picked weekdays below" and lets `weekdays` take precedence at
    submission if any checkbox was ticked.
- **`routineInspections`** (append-only "checklist report" log, separate from `routines` itself
  — the Checklist view calls submitting one of these "Submit report"): `routineId`, `staffId`,
  `imageUrl` (this specific report's photo, `''` if none attached — distinct from the routine's
  persistent `lastInspectedImageUrl`), `notes` (free text entered at submission), `subtaskResults`
  (array of `{id, text, done}`, a snapshot of that routine's subtasks and whether each was
  ticked at submission time), `inspectedAt`.
- **`notifications`**: `title`, `detail`, `createdAt`, `read`.
- **`holidays`** (Admin-maintained, drives the 1.5x pay multiplier — see Business logic section
  above): `date` (`YYYY-MM-DD`), `name` (free text, e.g. "Songkran"), `createdAt`. Managed from
  a small form inside the Financial view; write access is Admin+ only in `firestore.rules`
  (Managers can read but not add/remove holidays).
