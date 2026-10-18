# Portfolio Site With Booking and Ziina Deposits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the static portfolio into a booking-first site (scheme A, style 1) where a client picks a shoot, a free date from the owner's Google Calendar, and pays a deposit through Ziina.

**Architecture:** The existing Python generator (`tools/build.py`, `content.json`, `i18n.json`) keeps producing the static site in `docs/`. One pure JS module, `shared/pricing.mjs`, computes quotes and deposits and is used by both the browser (`docs/assets/pricing.mjs`, copied at build) and a Cloudflare Worker in `worker/` that checks availability, creates the Ziina payment, confirms it, writes the Google Calendar event and notifies Telegram. Part A ships without payments; Part B adds them on a test environment; Part C is the gated go-live.

**Tech Stack:** Python 3.9 (generator, unittest), Node 22 (`node:test`, ES modules, WebCrypto), Cloudflare Workers + KV, Ziina REST API, Google Calendar API (service account), Telegram Bot API, Playwright plugin for end-to-end runs.

**Spec:** `specs/2026-10-18-booking-site-design.md`

## Global Constraints

- English only; client comments stay in the original language. Reviews, photos and the removed-frame lists in `content.json` are not changed by this plan.
- No secrets in the repository or in browser code. Secrets: `ZIINA_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GOOGLE_SA_JSON` live only as Worker secrets entered by the owner.
- Site stays on GitHub Pages from `docs/`; every URL in generated HTML is relative (works under `/klemmenov-photo/` and on a future domain). Specs and plans live outside `docs/`.
- Fonts Playfair Display + Onest only; five type sizes: display, heading, lead, body 17px, small 15px; one accent `#c8a26b`; photos are never cropped (frame follows the photo's proportions).
- Contacts: WhatsApp `971557087169` with text "Hello, I’m booking through the website. Could you let me know which dates are available?", `https://t.me/klemmenov`, `https://www.instagram.com/klemmenov/`.
- Prices (AED): personal 1 200/h, min 1 h; commercial 1 500/h, min 2 h; event 1 500/h, min 2 h; hours 1..12. Studio Beauty Package 5 100; Premium Experience 10 200. Fixed add-ons: makeup artist 700; makeup artist and hair 1 000 per person; extra retouched photo 10 each; video editing 150 each. Quote-only add-ons (never charged online): second photographer from 1 200/h, assistant from 600/h, studio rental 315–500/h, travel outside Dubai 300–600.
- Deposit: personal 500; every other service 50% of the online total, rounded up to a whole AED. Slot hold 15 minutes. Booking horizon 60 days, minimum notice 24 h, working hours 09:00–20:00, buffer 30 min, timezone Asia/Dubai (UTC+4, no DST).
- Ziina amounts are integers in fils (AED × 100), `currency_code: "AED"`, `test: true` everywhere except production.
- Tests: Python `python3 -m unittest discover -s tests`, JS `node --test shared worker`. Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- `/terms/` and `/privacy/` are generated only when `content.json` has `"terms_approved": true`; until the owner approves the text, no page and no link to them exist and `/book/` stays in request-only mode.

## Review Focus

1. A client edits the request in the browser (lower hours, fake total, unknown add-on id): `/checkout` must price from the server table and reject invalid input. Owned by Tasks 2 and 13.
2. Two clients pay for the same slot at the same moment: the second `/checkout` gets 409 and no payment is created. Owned by Tasks 11 and 13.
3. A forged or replayed webhook (unknown id, not completed, amount differs, called twice): no calendar event is created and nothing is duplicated. Owned by Task 13.
4. Payment succeeds but Google Calendar fails: status `paid_needs_attention`, Telegram alert, client still sees confirmation. Owned by Task 13.
5. Hours that are 0, negative, fractional, huge or a string, and slots near midnight Dubai time (23:30 start crossing the UTC date): rejected or labelled in Dubai time. Owned by Tasks 2, 8 and 14.

---

## Part A: Redesign without payment (ships alone)

### Task 1: Site checker and test harness

**Files:**
- Create: `tools/check_site.py`, `tests/test_site.py`

**Interfaces:**
- Produces: `check_site.check(root: str) -> list[str]` returning one message per problem (unresolved relative `href`/`src`/`srcset`, absolute `/assets` paths, missing `alt`, missing `width`/`height` on `<img>`).

- [ ] **Step 1: Write the failing test** in `tests/test_site.py`: `test_current_site_has_no_problems` runs `tools/build.py` into a temp copy is not required; it calls `check_site.check("docs")` and asserts `== []`; `test_checker_reports_broken_link` writes a temp dir with `index.html` containing `<a href="nope/">` and asserts one message mentioning `nope/`.
- [ ] **Step 2: Run** `python3 -m unittest tests.test_site -v`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement** `check(root)` with `html.parser`; resolve each relative URL against the file's folder (`index.html` for folder URLs, skip `#`, `mailto:`, `https:`).
- [ ] **Step 4: Run** the same command. Expected: PASS (fix real findings in `docs/` if any appear and rebuild).
- [ ] **Step 5: Commit** `git add tools/check_site.py tests && git commit -m "test: site link and asset checker"`.

### Task 2: Shared pricing module

**Files:**
- Create: `shared/pricing.mjs`, `shared/pricing.test.mjs`, `docs/assets/pricing.json` (generated), `worker/pricing.json` (generated)
- Modify: `tools/build.py` (write both JSON files from `content.json` at build), `content.json` (add `"services"`, `"deposit"`, `"fixed_addons"`, `"quote_addons"`)

**Interfaces:**
- Produces: `quote(config, selection) -> { ok: true, serviceId, hours, lines: [{id,label,amount}], total: number, deposit: number, quoteOnly: string[] } | { ok: false, error: string }` where `selection = { serviceId: string, hours?: number, addons?: Record<string, number> }` (addon value = quantity or person count). `depositFor(config, serviceId, total) -> number`.

- [ ] **Step 1: Write failing tests** in `shared/pricing.test.mjs` with the constants above: `personal 1h → total 1200, deposit 500`; `commercial 2h → 3000, deposit 1500`; `event 3h → 4500, deposit 2250`; `beauty package → 5100, deposit 2550`; `premium → 10200, deposit 5100`; `personal 2h + makeup_hair ×2 + extra_retouch ×30 → 2400+2000+300 = 4700, deposit 500`; `commercial 3h + makeup 1 → 4500+700 = 5200, deposit 2600`; odd total `event 3h + video_edit 1 → 4650, deposit 2325`, and a total that yields .5 rounds up (`ceil`); `second_photographer` listed in `quoteOnly`, not in `total`; rejects hours `0, -1, 0.5, 13, "2", NaN, 1e9` with `error: "invalid_hours"`; rejects commercial `1` hour (`"below_minimum"`); rejects unknown service and unknown add-on id (`"unknown_service"`, `"unknown_addon"`); rejects non-integer or negative quantities (`"invalid_quantity"`).
- [ ] **Step 2: Run** `node --test shared`. Expected: FAIL.
- [ ] **Step 3: Implement** both functions as pure ES module code reading only the `config` argument; deposit rule from `config.deposit` (`{personal: 500, default_percent: 50}`), `Math.ceil`.
- [ ] **Step 4: Run** `node --test shared`. Expected: PASS.
- [ ] **Step 5: Build wiring:** `tools/build.py` writes `docs/assets/pricing.json` and `worker/pricing.json` and copies `shared/pricing.mjs` to `docs/assets/pricing.mjs`; add `tests/test_site.py::test_pricing_json_matches_content`. Run `python3 -m unittest discover -s tests` (PASS).
- [ ] **Step 6: Commit** `feat: shared pricing and deposit rules`.

### Task 3: Content model for the new home

**Files:**
- Modify: `content.json` (add `"service_cards"`, `"how_it_works"`, `"faq"`, `"terms_approved": false`), `i18n.json` (strings for cards, steps, FAQ, work hub, book page)
- Test: `tests/test_site.py`

**Interfaces:**
- Produces in `content.json`: `service_cards: [{id: "personal"|"event"|"commercial", from: number, bullets: string[]}]` (bullets copied verbatim from the existing included lists), `how_it_works: string[4]` (choose, add-ons and date, pay deposit, shoot and delivery), `faq: [{q, a}]` limited to statements the owner has already confirmed (min hours, studio not included, add-ons list, "number of people, time and details are agreed in advance"). Delivery times and refund text are NOT included until approved.

- [ ] **Step 1: Write failing test** `test_service_cards_match_pricing`: for each card `from` equals the matching rate in `content.json["hourly"]`.
- [ ] **Step 2: Run, expect FAIL**; **Step 3: add data**; **Step 4: run, expect PASS**; **Step 5: commit** `feat: content model for booking-first home`.

### Task 4: Home page restructure (scheme A)

**Files:**
- Modify: `tools/build.py` (`home()`), `i18n.json`, `docs/assets/style.css`
- Test: `tests/test_site.py`

**Interfaces:**
- Consumes: `service_cards`, `how_it_works`, `faq` from Task 3.
- Produces: home sections in this order, each with an `id`: `hero`, `services`, `how`, `work`, `packages`, `reviews`, `faq`, `book`. Service card CTA href: `book/?service=<id>`.

- [ ] **Step 1: Write failing tests:** `test_home_section_order` (ids appear in the order above), `test_service_cards_link_to_book` (three links `book/?service=personal|event|commercial`), `test_home_hero_shows_from_price` (hero contains `1,200`), `test_home_no_duplicate_hero_cta` (exactly one primary "Book" button inside `#hero` besides the header's).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `home()` sections: hero keeps the five 2:3 portraits and the name, adds one lead line plus the from-price; `services` three cards; `how` four steps as an ordered list; `work` six frames per series from existing sets, linking to `work/`; `packages` two package cards linking `book/?service=beauty|premium`; `reviews` three review articles; `faq` details list; `book` closing CTA. Style additions in `style.css` only with existing tokens.
- [ ] **Step 4: Run tests, expect PASS;** run `python3 tools/check_site.py` equivalent test (Task 1) PASS.
- [ ] **Step 5: Commit** `feat: booking-first home`.

### Task 5: Work hub, navigation, prices page and gated legal pages

**Files:**
- Modify: `tools/build.py` (`NAVP`, new `work()`, `terms()`, `privacy()`, `prices()`), `i18n.json`
- Test: `tests/test_site.py`

**Interfaces:**
- Produces: `docs/work/index.html` (three series cards with title, count of frames, link); nav labels `Main, Work, Prices, Reviews, Contact` with `Work → work/`; when `terms_approved` is true: `docs/terms/index.html`, `docs/privacy/index.html` and footer links; when false: neither exists and no page links to them.

- [ ] **Step 1: Write failing tests:** `test_nav_work_points_to_hub`; `test_work_hub_counts_match_galleries` (count in card equals anchors in each gallery page); `test_terms_gated` (with `terms_approved: false` no `docs/terms/` and no `terms/` href anywhere; with true both pages exist) using a temp copy of `content.json` passed to the build via env var `SITE_CONTENT`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `prices()` gets jump links to `#rates #packages #addons #faq` and the FAQ block; `build.py` reads `SITE_CONTENT` if set.
- [ ] **Step 4: Run, expect PASS.** **Step 5: Commit** `feat: work hub, nav, gated legal pages`.

### Task 6: Visual pass (style 1)

**Files:**
- Modify: `docs/assets/style.css`, `docs/assets/app.js`, `tools/build.py` (events collage grid, sticky bar markup)
- Test: `tests/test_site.py`, manual inspector run

- [ ] **Step 1: Write failing tests:** `test_type_scale_has_five_sizes` (parses `font-size` declarations in `style.css`, expects ≤ 5 distinct non-display sizes plus the display clamp values listed in `:root` tokens); `test_mobile_book_bar_markup` (every page contains one `<a class="bookbar">` whose href is the WhatsApp or `book/` link); `test_events_collage_has_no_empty_cells` (collage uses `align-items:start` and equal row structure, asserted by class names).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement:** collapse sizes to the five tokens already in `:root`; reduce `.pad` and chapter gaps by about a third; fix events grid; add `.bookbar` fixed to the bottom on `max-width: 900px` showing "Book · from 1,200 AED", hidden on `/book/`; `app.js` hides it while the footer is visible.
- [ ] **Step 4: Run tests, then** `node ~/.claude/skills/taste-skill/scripts/inspect.mjs docs/index.html` (and `docs/prices/index.html`, `docs/reviews/index.html`). Expected: no FAIL except the accepted emoji finding in reviews; view `desktop-fold`, `tablet-fold`, `mobile-fold`, `mobile-page-01` screenshots and confirm no cropped photo, no horizontal scroll.
- [ ] **Step 5: Commit** `style: tighten spacing, five type sizes, mobile book bar`.

### Task 7 (Part A close): `/book/` request mode and publish

**Files:**
- Create: `docs/assets/book.js` (source in `shared/book-ui.mjs`), build `book()` in `tools/build.py`
- Test: `shared/book-ui.test.mjs`, `tests/test_site.py`

**Interfaces:**
- Consumes: `quote()` from Task 2 via `assets/pricing.mjs` and `assets/pricing.json`.
- Produces: `buildWhatsAppText(selectionResult, contact) -> string` (base greeting + service, hours, add-on lines, quote-only lines, total, preferred date text) and the `/book/` page showing steps 1, 2 and 4 (service and hours, add-ons, contact) with a "Request in WhatsApp" button; step 3 (date) and the pay button are absent until Part B sets `"booking_api"` in `content.json`.

- [ ] **Step 1: Write failing tests:** `shared/book-ui.test.mjs::whatsapp_text_includes_lines_and_total` (selection `event 3h + makeup 1` yields lines `Event photography, 3 hours`, `Makeup artist`, `Total online: 5 200 AED`); `tests/test_site.py::test_book_page_request_mode` (page has no `Pay deposit` button while `booking_api` empty; has `?service=` preselect script).
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement** the ES module and the page; preselect from `?service=`.
- [ ] **Step 4: Run** `node --test shared` and `python3 -m unittest discover -s tests`, then publish: rebuild, `git push`, confirm Pages build, run `check_site` against the live URL list, open home, `/book/?service=personal`, `/work/` at 390 and 1440 px with the Playwright tools and the inspector. Expected: all 200, no console errors.
- [ ] **Step 5: Commit** `feat: book page in request mode` and push.

---

## Part B: Booking backend on a test environment

### Task 8: Slot computation

**Files:** Create `worker/availability.mjs`, `worker/availability.test.mjs`

**Interfaces:** Produces `computeSlots({ busy: [{start,end}], durationMin: number, workHours: {from:"09:00", to:"20:00"}, bufferMin: 30, minNoticeHours: 24, horizonDays: 60, now: string, held: [{start,end}], stepMin: 30 }) -> string[]` (ISO strings with `+04:00`).

- [ ] **Step 1: Failing tests:** free day returns starts from 09:00 to the last start that fits before 20:00; a busy 12:00–14:00 removes starts from 11:00 minus duration minus buffer through 14:30; notice rule (`now` 10:00 hides everything before next day 10:00); held range removes the same as busy; a start at 23:30 Dubai (outside hours) never appears, and a busy event stored in UTC crossing midnight Dubai still blocks the right slots; `durationMin` 0, negative or NaN throws `RangeError`.
- [ ] **Step 2: Run** `node --test worker`, FAIL. **Step 3: Implement** with integer minutes since epoch, fixed offset +04:00. **Step 4: PASS. Step 5: Commit** `feat(worker): slot computation`.

### Task 9: Ziina client

**Files:** Create `worker/ziina.mjs`, `worker/ziina.test.mjs`

**Interfaces:** Produces `createIntent(env, { amountAed: number, message: string, successUrl: string, cancelUrl: string, expiryMs: number, test: boolean }, fetchImpl) -> { id, redirectUrl }` and `getIntent(env, id, fetchImpl) -> { id, status, amountFils, currency }`.

- [ ] **Step 1: Failing tests with a fake `fetch`:** request goes to the Ziina payment-intent endpoint with header `Authorization: Bearer <env.ZIINA_TOKEN>`; body has `amount: amountAed*100`, `currency_code: "AED"`, `test: true`, `success_url`, `cancel_url`, `expiry`; response `redirect_url` is returned; non-2xx throws `ZiinaError` containing status; `getIntent` returns `status: "completed"` mapping. (Confirm the endpoint path and fields against `https://docs.ziina.com/api-reference/payment-intent/create.md` while writing this task; the test pins whatever the docs state.)
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS. Step 5: Commit** `feat(worker): ziina client`.

### Task 10: Google Calendar client

**Files:** Create `worker/google.mjs`, `worker/google.test.mjs`

**Interfaces:** Produces `getBusy(env, {from, to}, fetchImpl) -> [{start,end}]`, `createEvent(env, booking, fetchImpl) -> { eventId }`, `signJwt(serviceAccount, scope, now) -> string` (RS256 via WebCrypto).

- [ ] **Step 1: Failing tests:** `signJwt` output verifies with the matching public key generated in the test; `getBusy` posts to free/busy with `timeZone: "Asia/Dubai"` and returns normalized ranges; `createEvent` posts summary `"<service> · <name>"`, start/end with `timeZone`, description containing contact and quote-only lines with HTML and newlines escaped as plain text; token fetch failure throws `GoogleError`.
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS. Step 5: Commit** `feat(worker): google calendar client`.

### Task 11: Booking state in KV

**Files:** Create `worker/bookings.mjs`, `worker/bookings.test.mjs` (in-memory KV double in the test)

**Interfaces:** Produces `createHold(kv, booking, now) -> {ok:true,id}|{ok:false,error:"slot_taken"}`, `getBooking(kv, id)`, `markPaid(kv, id, intent, now) -> {changed:boolean, booking}`, `markNeedsAttention(kv, id, reason)`, `releaseExpired(kv, now)`. Statuses: `held | paid | paid_needs_attention | expired`.

- [ ] **Step 1: Failing tests:** second `createHold` on an overlapping interval returns `slot_taken` (concurrent-attempt test using `Promise.all`); `markPaid` twice returns `changed:false` the second time; `markPaid` with an amount differing from the booking deposit throws `AmountMismatch`; expired hold frees the slot.
- [ ] **Step 2: FAIL. Step 3: implement** (slot index key per day to make overlap checks atomic enough for single-owner volume). **Step 4: PASS. Step 5: Commit** `feat(worker): booking state machine`.

### Task 12: Telegram notifier

**Files:** Create `worker/telegram.mjs`, `worker/telegram.test.mjs`

**Interfaces:** Produces `notify(env, text, fetchImpl) -> void`, `formatPaid(booking) -> string`, `formatAttention(booking, reason) -> string` (Markdown special characters escaped).

- [ ] **Steps:** failing tests (message contains service, Dubai-time start, name, contact, deposit paid, remaining amount, quote-only lines; user text with `*_[]` is escaped); implement; pass; commit `feat(worker): telegram notifications`.

### Task 13: Worker routes

**Files:** Create `worker/index.mjs`, `worker/index.test.mjs`, `worker/wrangler.toml` (KV binding `BOOKINGS`, vars `ALLOWED_ORIGINS`, `SITE_URL`, `ZIINA_TEST`), `worker/booking-config.json` (hours, buffer, notice, horizon, hold minutes)

**Interfaces:** Consumes Tasks 2 and 8–12. Produces `handle(request, env, ctx, deps) -> Response` with routes `GET /availability`, `POST /checkout`, `POST /webhook/ziina`, `GET /booking/:id`; JSON errors `{error: code}`.

- [ ] **Step 1: Failing tests (all via `handle` with fakes):**
  - `checkout_prices_on_server`: body claims `total: 1`, hours `1`, service `commercial`; response is 400 `below_minimum`; with valid hours the Ziina call receives the deposit computed by `quote`, never a client value (Review Focus 1).
  - `checkout_rejects_bad_input`: hours `0, -1, 0.5, "2", 1e9`, unknown add-on id, missing contact, missing `accepted_terms`, oversized notes (> 1000 chars).
  - `checkout_slot_race`: two `Promise.all` checkouts for one slot: one 200, one 409 `slot_taken`, exactly one Ziina call (Review Focus 2).
  - `webhook_ignores_forged`: unknown id → 200 no-op; `getIntent` says `pending` → no event; amount mismatch → needs-attention; second delivery of a paid id → no second calendar event (Review Focus 3).
  - `paid_but_calendar_fails`: `createEvent` throws → booking `paid_needs_attention`, Telegram attention message sent, `GET /booking/:id` still returns `status: "paid"` public fields (Review Focus 4).
  - `cors`: allowed origin gets headers, other origin gets none; `rate_limit`: the 11th request per minute from one IP returns 429.
- [ ] **Step 2: FAIL. Step 3: implement** validation, routing, CORS allow-list, KV rate counter; webhook never trusts the payload, always calls `getIntent`. **Step 4: PASS** `node --test worker`. **Step 5: Commit** `feat(worker): booking routes`.

### Task 14: `/book/` live mode

**Files:** Modify `shared/book-ui.mjs`, `tools/build.py` (`book()`), `content.json` (`booking_api`), add `docs/book/thanks/`, `docs/book/cancelled/` via build
- Test: `shared/book-ui.test.mjs`, `tests/test_site.py`

**Interfaces:** Produces `loadSlots(api, selection, fetchImpl) -> string[]`, `submitCheckout(api, payload, fetchImpl) -> {redirectUrl}`, and a thanks page that polls `GET /booking/:id` every 3 s up to 60 s.

- [ ] **Step 1: Failing tests:** slots grouped by Dubai date with the label "Dubai time (UTC+4)"; API failure renders the WhatsApp fallback text from Task 7; pay button disabled until date, contact and terms are chosen; thanks page shows paid, pending and unknown-id states.
- [ ] **Step 2: FAIL. Step 3: implement** (only active when `booking_api` is non-empty; otherwise Task 7 behaviour stays). **Step 4: PASS** both suites. **Step 5: Commit** `feat: live booking steps`.

### Task 15: Owner setup guide and staging deploy

**Files:** Create `SETUP-booking.md` (Russian, step by step), `worker/README.md`

- [ ] **Step 1:** Write the guide covering: Cloudflare account and `wrangler deploy` to a staging Worker; creating the KV namespace; Ziina token (ziina.com/business/connect → "Other builder or custom"); Google service account, enabling Calendar API and sharing the booking calendar with the service-account email as "Make changes to events"; Telegram bot token and chat id (reuse the lead bot); `wrangler secret put ZIINA_TOKEN|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|GOOGLE_SA_JSON`; one `curl` that registers the Ziina webhook URL; setting `booking_api` and rebuilding. Mark every step "you do this, tokens are never sent to Claude".
- [ ] **Step 2:** Stop and hand the guide to the owner; wait for staging URL and confirmation that secrets are set (this task has no code gate).
- [ ] **Step 3: Commit** `docs: owner setup guide for booking backend`.

### Task 16: Staging end-to-end run

**Files:** Create `tests/e2e/booking.md` (recorded run notes)

- [ ] **Step 1:** With `ZIINA_TEST=true`, use the Playwright tools to run: home → card → `/book/?service=personal` → date → contact → Pay → Ziina test card from `https://docs.ziina.com/test-cards.md` → thanks page `paid`. Expected: calendar event exists, Telegram message received, slot disappears from `/availability`.
- [ ] **Step 2:** Run the failure paths: cancel at Ziina (slot returns after hold expiry), Worker stopped (WhatsApp fallback appears), second browser picking the same slot (409 message).
- [ ] **Step 3:** Run the `security-guidance` review and `/code-review` on `worker/`; fix findings with tests first.
- [ ] **Step 4: Commit** `test: staging e2e notes`.

---

## Part C: Go-live (gated)

### Task 17: Approvals and production switch

**Files:** Modify `content.json` (`terms_approved`, deposit/hours values the owner confirms), `i18n.json` (terms and FAQ text exactly as approved), `worker/wrangler.toml` (production vars)

- [ ] **Step 1:** Owner confirms in writing: refund and reschedule rules, delivery times, working hours, buffer, VAT wording, commercial-licence question. Do not proceed without each item.
- [ ] **Step 2:** Set `terms_approved: true`, rebuild, run all test suites and the inspector; publish.
- [ ] **Step 3:** Switch the Worker to production (`ZIINA_TEST=false`, owner replaces nothing else), make one real minimum payment with the owner's own card, confirm the event and Telegram message, refund it in Ziina, record the result in `tests/e2e/booking.md`.
- [ ] **Step 4: Commit** `chore: go live with approved terms` and update `README.md`, memory note `klemmenov-site.md`.

---

## Self-review

- **Spec coverage:** structure (§4) Tasks 4–5; style (§5) Task 6; steps and deposits (§6) Tasks 2, 7, 14; Worker routes (§7) Tasks 8–13; errors (§8) Tasks 13–14, 16; testing (§9) every task plus 16; phases (§10) Parts A–C; owner dependencies (§11) Tasks 15 and 17.
- **Consistency:** `quote`, `depositFor`, `computeSlots`, `createHold`, `markPaid`, `createIntent`, `getIntent`, `getBusy`, `createEvent`, `notify` are defined once and consumed by name in Tasks 13–14.
- **Proportion:** plan sits at roughly 1.4× the spec; code blocks are absent, tasks carry signatures, test names and assertions only.
