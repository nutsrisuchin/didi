# CLAUDE.md

Guidance for Claude Code working in this repo. Sections marked **[Reusable]** describe
patterns that aren't specific to this app — they're worth copying wholesale into any
similar "no-build, vanilla JS + Firebase, hosted on GitHub Pages" project.

## Project snapshot

**Didi Malatang Hub** — a staff timesheet/payroll, ingredient warehouse, and routine
food-safety-style inspection app for **Didi Malatang**, a malatang restaurant. Vanilla HTML/CSS/JS, no
framework, no build step, no `package.json`. Backed by Firebase (Firestore + Auth only — no
Storage, see below). Deployed on GitHub Pages, auto-deploys on push to `main`.

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
- There is no modal system yet (no `#modal-host`) — every view renders inline into `#view`.
  If a future feature needs a modal, that's new infrastructure to design, not an existing
  convention to reuse.

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
- **Admin**: manage `staff` (any role except can't touch the App Owner), timesheet, warehouse,
  checklist, notifications, and the **Financial section** (`/financial` view, `data-role-min="Admin"`
  on its nav button plus an explicit `render()` gate — see Business logic section below), which
  is also where **salary/`dailyRate` is viewed and edited** — Admin+ only, deliberately narrower
  than the rest of `staff` management Admin otherwise has.
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
- **Employee**: log in, view their own attendance history only (`renderTimesheet` filters the
  staff list to `state.currentUser.uid` when `!canManage`), tick off checklist sub-tasks and
  submit checklist reports. Read-only everywhere else.
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
  - **Quick daily mark** (Timesheet's top "ภาพรวมการลงเวลา" section, `mark-attendance` action):
    clock-in is rounded up to the next half hour via `roundUpToHalfHour()` — e.g. `10:10→10:30`,
    `10:35→11:00` — and clock-out is always the fixed schedule end. This is for tapping "mark
    present" in the moment someone actually arrives.
  - **Monthly schedule grid, exact-time override** (`save-schedule-cell` action, behind a
    collapsed `<details>` disclosure so it isn't the first thing a manager sees for an ordinary
    day): both clock-in and clock-out are taken from the two time inputs *exactly as typed, with
    no rounding* — for correcting a specific day (e.g. someone came in late), not for routine use.
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
- Pay formula (`calculateDailyPay(dailyRate, lateMinutes, isHoliday)`):
  `max(0, dailyRate × (isHoliday ? 1.5 : 1) − ceil(lateMinutes/60)×40)`. `isHoliday` comes from
  `isHolidayDate(date)`, which checks the admin-maintained `holidays` collection (see Data model
  below) — there is no per-attendance-record checkbox for marking a day as a holiday, it's
  entirely driven by that date list.
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
- When genuinely unsure how something behaves on iPhone Safari vs. desktop Chrome (camera
  `capture="environment"` input behavior, viewport height quirks), say so explicitly rather
  than assuming parity — this app relies on `<input type="file" capture="environment">` for
  warehouse/routine photo capture, which is worth testing on an actual device if a bug is
  ever reported there.

## [Reusable] GitHub Pages deployment gotchas

- No build step: pushing to `main` is the deploy. There is no staging environment.
- **The GitHub Pages CDN caches aggressively** — a push can take longer than expected to be
  visible; verify via `curl -sI <url> | grep -Ei 'last-modified|age'` against the live URL
  before assuming a just-shipped fix is broken.
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
  that date), `updatedBy` (the acting user's Auth uid — set by every write path, see Business
  logic section above), `createdAt`.
- **`warehouseItems`**: `category` (free text — no fixed category list, same convention as
  `unit`; the Warehouse view groups items into collapsible sections by this field, falling
  back to `'อื่นๆ'` when unset), `name`, `unit` (free text — no fixed unit list), `quantity`
  (decimal, e.g. `1.5` for a partially-used pack), `imageUrl` (compressed base64 JPEG data URL,
  or `''` — settable at creation, and separately addable/replaceable later per-item via the
  Warehouse view's "เพิ่มรูป"/"เปลี่ยนรูป" control, `update-item-photo` action), `createdAt`.
- **`warehouseLogs`** (append-only, one doc per quantity snapshot — written whenever an item is
  created, its quantity is updated, or the stock-sheet seed imports it): `itemId`, `quantity`,
  `recordedAt`. This is the only history the app keeps of stock levels over time; it drives the
  Warehouse view's "Restock priorities" section via `computeStockInsight(item)`, which mirrors
  the usage-rate methodology the user already used by hand in `stock_data_1.md` — average daily
  usage is `Σ(declines between consecutive logs) / Σ(days over those same declining periods)`
  (periods where quantity went *up*, i.e. a restock, are excluded so they don't read as negative
  usage), reorder point is `usagePerDay × 7 × 1.3`, suggested order quantity is
  `usagePerDay × 14 − currentQuantity`. Needs at least two log entries with an actual decline
  between them to produce a rate — until then `computeStockInsight` returns `{ hasData: false }`
  and the item is excluded from the priority list (shown instead as a "not enough data yet"
  count). The Home page's "Warehouse health" card (`.card.clickable`, `data-action="nav-warehouse"`)
  navigates straight into this section rather than opening a modal, consistent with this app
  having no modal system.
- **`routines`** (user-facing label is "Checklist" throughout the UI — the collection name and
  internal `state.view === 'routines'` were kept as-is to avoid a Firestore-path/rules churn for
  what is otherwise a pure relabel+redesign): `name`, `description` (short free-text summary),
  `detail` (longer free-text instructions), `subtasks` (array of `{id, text}`, parsed from a
  one-line-per-subtask textarea on the create form — no per-definition "done" state, since
  that's re-ticked fresh on every completion), `frequencyDays`, `lastInspectedAt`,
  `lastInspectedImageUrl` (persists across completions — only overwritten when a report attaches
  a new photo), `createdAt`. `getRoutineStatus()` compares `lastInspectedAt + frequencyDays`
  against `now`.
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
