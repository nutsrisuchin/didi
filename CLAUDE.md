# CLAUDE.md

Guidance for Claude Code working in this repo. Sections marked **[Reusable]** describe
patterns that aren't specific to this app — they're worth copying wholesale into any
similar "no-build, vanilla JS + Firebase, hosted on GitHub Pages" project.

## Project snapshot

**Didi Malatang Hub** — a staff timesheet/payroll, ingredient warehouse, and routine
food-safety-style inspection app for **Didi Malatang**, a malatang restaurant. Vanilla HTML/CSS/JS, no
framework, no build step, no `package.json`. Backed by Firebase (Firestore + Auth only — no
Storage, see below). Deployed on GitHub Pages, auto-deploys on push to `master`.

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
  under a synthetic email derived from their name (`emailForName()` in `db.js`, currently
  `slugified-name@didi-malatang.local`), with their PIN as the password — a real server-side check
  via Firestore Security Rules, not just a UI gate.
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
  routines, notifications.
- **Manager**: add/remove `Employee`-role staff (from the Timesheet page's own "Remove
  employee" button, not the Admin page — Managers can't reach `/admin` at all), mark
  attendance, manage warehouse items, create/manage routines. Cannot touch Manager/Admin/Owner
  accounts.
- **Employee**: log in, view their own attendance history only (`renderTimesheet` filters the
  staff list to `state.currentUser.uid` when `!canManage`), upload routine inspection photos.
  Read-only everywhere else.
- A Manager creating a new `staff` doc is restricted server-side to `role in ['Employee',
  'Manager']` (`firestore.rules`) — without that split a Manager could craft a raw Firestore
  write to self-promote to Admin/Owner via the same "create" permission that lets them add
  employees. Don't relax the create rule to a flat `roleAtLeast('Manager')` without re-adding
  that role allowlist.

## Business logic: schedule, rounding, pay (Didi Malatang-specific)

- Schedule: weekday `10:00–21:00`, weekend `09:00–20:00` (11h span, 1h unpaid lunch → 10
  worked hours baseline). `scheduleFor(date)` in `app.js`.
- Clock-in is rounded up to the next half hour via `roundUpToHalfHour()` — e.g. `10:10→10:30`,
  `10:35→11:00`. Clock-out is always the fixed schedule end; there's no early-leave/overtime
  handling yet.
- `lateMinutes = max(0, roundedArrival − scheduledStart)`;
  `workedHours = max(0, (scheduledEnd − roundedArrival) − 60min)`.
- Part-time pay (`calculatePartTimePay`): `440 + (50 if workedHours < 8 else 0) −
  ceil(lateMinutes/60)×40`, floored at 0.
- **Full-time pay/deduction math is intentionally not implemented** — full-time attendance
  records `clockIn`/`clockOut`/`lateMinutes` for the day but `pay` is always `null`. Don't add
  full-time deduction logic without checking with the user first; this was explicitly deferred
  ("dig deeper later for full time"), not an oversight.

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

- No build step: pushing to `master` is the deploy. There is no staging environment.
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

Firestore collections: `staff`, `attendance`, `warehouseItems`, `routines`,
`routineInspections`, `notifications`. No Storage bucket — see the "no Firebase Storage" note
above; images live inline on the docs below as base64 data URLs.

- **`staff`** (doc ID = Auth `uid`): `name`, `role` (`App Owner`/`Admin`/`Manager`/`Employee`),
  `employmentType` (`full-time`/`part-time`/`''` for non-hourly Owner/Admin accounts),
  `salary` (full-time fixed monthly amount, `null` otherwise), `active`, `createdAt`. One
  collection covers both "employee for payroll" and "login account with a role" — the
  Timesheet page's "Add employee" form and the Admin page's "Add account" form both write
  here, just with different allowed `role` values (see RBAC section above).
- **`attendance`** (doc ID = `` `${date}_${staffId}` `` — deterministic, so marking attendance
  twice for the same person/day upserts instead of duplicating): `staffId`, `date`
  (`YYYY-MM-DD`), `clockIn`, `clockOut`, `lateMinutes`, `workedHours`, `pay` (part-time only,
  `null` for full-time), `createdAt`.
- **`warehouseItems`**: `name`, `unit` (free text — no fixed unit list), `quantity`,
  `imageUrl` (compressed base64 JPEG data URL, or `''`), `createdAt`.
- **`routines`**: `name`, `frequencyDays`, `lastInspectedAt`, `lastInspectedImageUrl`,
  `createdAt`. `getRoutineStatus()` compares `lastInspectedAt + frequencyDays` against `now`.
- **`routineInspections`** (append-only audit log, separate from `routines` itself): `routineId`,
  `staffId`, `imageUrl`, `inspectedAt` — lets the app show who inspected what and when, not
  just each routine's single latest timestamp.
- **`notifications`**: `title`, `detail`, `createdAt`, `read`.
