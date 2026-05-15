# CLAUDE.md — Dostt Free Rewards: Full Project Documentation

## What This Is

A WebView page embedded inside the Dostt app (Behtar Technology Pvt. Ltd.).
Users earn "Dostt Points" by spending coins on audio/video calls, then claim free coin rewards at 17 milestone tiers. Resets every 30 days per user.

---

## Running Locally

```bash
# Serve frontend (from project root)
python3 -m http.server 8080
# → http://localhost:8080

# Start backend + Postgres
docker compose up -d

# First-time DB setup (or after schema changes)
docker compose exec backend npm run migrate

# Backend dev (hot reload)
cd backend && npm run dev

# pgAdmin UI
# → http://localhost:5050  (admin@dostt.com / admin)
```

---

## Architecture Overview

```
Dostt App (WebView)
      │
      ▼
  index.html
  app.js (Vanilla JS SPA)       ← frontend, no build step
  styles.css
      │
      │  fetch(/auth/login, /rewards/me, /rewards/claim)
      ▼
  Node.js + Express backend     ← /backend
      │
      ├── PostgreSQL (via Docker)
      │     users, user_points, claimed_rewards,
      │     claim_notifications, login_logs, points_audit
      │
      ├── Redash (BigQuery)
      │     Query 17538 — phone → user_id  (login verification)
      │     Query 17564 — all LTV 500-1500 users + spend data
      │
      └── Dostt Wallet API      ← credits coins on claim
```

---

## Frontend (`app.js`)

### Key Facts
- Vanilla JS, no framework, no build step
- Single file: `app.js`. Everything is in here.
- Tailwind CDN + `styles.css` for styling
- `render()` sets `root.innerHTML` — full DOM rebuild on every state change
- Scroll positions saved/restored before/after every `render()` call (prevents jumping)

### State Object
```js
const state = {
  view: "login",            // "login" | "rewards" | "terms"
  phone: "",
  country: COUNTRIES[0],    // { flag, name, code }
  totalSpent: 0,            // adjusted points for current cycle
  lastRefreshedAt: null,    // from Redash last_refreshed_at_ist
  dataUpdatedAt: null,      // from user_points.updated_at
  cycleEndDate: null,       // cycle end ISO string
  claimed: new Set(),       // tier IDs claimed this cycle
  claimingTiers: new Set(), // tier IDs with in-flight API calls (prevents double-click)
  dataLoading: true,        // true until first /rewards/me completes (prevents flash)
  toast: "",
  loading: false,
  isTester: false,
  testMode: null,           // null | "api" | "direct_select" | "bypass"
  claimType: "real",        // "real" | "dummy"
  showTestModal: false,
};
```

### Views
| View | Description |
|---|---|
| `login` | Phone + country picker. Calls `POST /auth/login`. |
| `rewards` | Progress card + 17 tier cards. Main page. |
| `terms` | T&C page. Back button returns to previous view. |

### Tier Cards Logic
```
claimable = !state.dataLoading
            && (totalSpent >= tier.unlockAt || isDirectSelect)
            && !isClaimed
            && prevTierClaimed   ← sequential: must claim tier N-1 before N
```
- While `state.dataLoading = true`: all tiers show as locked (no flash of wrong state)
- While `state.claimingTiers.has(tier.id)`: button shows "Claiming…" (disabled)
- After claim success: `state.claimed.add(tierId)` → button shows "Claimed"

### Claim Flow (Frontend)
1. Button clicked → `state.claimingTiers.add(tierId)` → `render()` (button locks immediately)
2. `POST /rewards/claim` called
3. On success → `state.claimingTiers.delete(tierId)` + `state.claimed.add(tierId)` + toast
4. On 409 → `state.claimed.add(tierId)` silently (already claimed, sync local state)
5. On other error → toast with error message

### Test Phones
```js
const TEST_PHONES = ["9500365660", "9988818731"];
```
Test phones see a modal on login (and session restore) to pick test mode:
- **API** — hits backend, saves to DB, normal points check
- **Direct Select** — all tiers unlocked, hits backend, saves to DB
- **Bypass** — fully offline, no API calls, resets on logout

### Session Persistence
`localStorage("dostt_session")` stores `{ phone, country }`.
On page load: if session exists → skip login, go straight to rewards, load data in background.
Test phones on session restore → show test modal again (so they can pick mode).

### API Helper
```js
async function api(path, options = {}) {
  // Calls API_BASE + path
  // localhost → http://localhost:3001
  // production → /api
  // No auth headers — phone in body/query is the identity
}
```

### Cache Busting
`index.html` references `app.js?v=YYYYMMDD-N` and `styles.css?v=YYYYMMDD-N`.
**Always bump the version string when deploying changes.**

---

## Backend (`/backend`)

### Entry Point
`src/index.js` — Express app, CORS, JSON body parser.
Routes: `/auth`, `/rewards`, `/admin`

### Environment Variables (`.env`)
```
PORT=3001
DB_ADAPTER=postgres                        # "postgres" | "supabase"
DATABASE_URL=postgres://dostt:dostt_secret@postgres:5432/dostt_rewards
CYCLE_DAYS=30
REDASH_BASE_URL=https://app.redash.io/...
REDASH_API_KEY=...
REDASH_VERIFY_PHONE_QUERY_ID=17538         # phone → user_id lookup
REDASH_USER_POINTS_QUERY_ID=17564          # all LTV 500-1500 users
DOSTT_WALLET_API_URL=...                   # coin credit endpoint
DOSTT_WALLET_AUTH_KEY=...                  # x-n8n-auth-key header
ADMIN_API_KEY=...                          # for /admin/* endpoints
```

### DB Layer (`src/db/`)
Generic adapter pattern. `client.js` exports the right adapter based on `DB_ADAPTER`.
Both adapters expose identical interface:
```
findOne(table, conditions)
findMany(table, conditions, { orderBy?, limit? })
insert(table, data)          → returns inserted row
upsert(table, data, conflictColumns[])
update(table, conditions, data)
delete(table, conditions)
query(sql, params[])         → raw SQL escape hatch
```

---

## API Routes

### `POST /auth/login`
**Body:** `{ phone, countryCode? }`

**Flow:**
1. Validate phone (7–15 digits)
2. If not test phone: call Redash 17538 with `{ mobile_numbers: phone }` → verify user is registered Dostt user
3. Upsert `users` table
4. On first login: set `cycle_start_date = now`, `cycle_baseline_points = 0`
5. Save `dostt_user_id` from Redash to `users.dostt_user_id`
6. Write to `login_logs`

**Response:** `{ success, user: { phone, countryCode }, isTester }`

**Errors:**
- 400 — invalid phone
- 403 — not a registered Dostt user
- 503 — Redash unavailable

---

### `GET /rewards/me`
**Query:** `?phone=&countryCode=`

**Flow:**
1. Call `getOrRefreshPoints(phone, countryCode)` — this may reset cycle if 30 days passed
2. Read `cycle_start_date` from DB (post-refresh so any reset is reflected)
3. Query `claimed_rewards` for current `cycle_start_date`

**Response:**
```json
{
  "totalSpent": 1250,
  "walletBalance": 450,
  "spentOnAudio": 800,
  "spentOnVideo": 450,
  "ltv": 1100,
  "lastRefreshedAt": "14/05/2026 18:30",
  "dataUpdatedAt": "2026-05-14T13:00:00Z",
  "claimedTiers": [1, 2, 3],
  "isTester": false,
  "cycle": { "startDate": "...", "endDate": "..." }
}
```
Test phones always get `totalSpent = 24350` (all tiers unlocked).

---

### `POST /rewards/claim`
**Body:** `{ phone, countryCode?, tierId, claimMode?, claimType? }`

**Flow:**
1. Validate tierId against TIER_DATA
2. `getUserCycleStartDate` — get current cycle
3. Check `claimed_rewards` — if exists → 409
4. `getOrRefreshPoints` — verify enough points
5. Resolve `dostt_user_id` from DB (fallback: call Redash 17538)
6. Insert `claim_notifications` with status `"pending"`
7. Call Dostt Wallet API → credit coins
8. Update `claim_notifications` to `"success"` or `"failed"`
9. Insert `claimed_rewards` — unique constraint catches race condition (23505 → 409)

**Response:** `{ success: true, coinsAwarded: 30, claimed: {...} }`

**Errors:**
- 400 — invalid phone / tierId / user not found
- 403 — not enough points
- 409 — already claimed this cycle
- 502 — wallet API failed or can't resolve dostt_user_id

---

## Redash Queries

### Query 17538 — Phone Verification
**Parameter:** `{{ mobile_numbers }}`
**Used by:** `POST /auth/login` (verify user exists) + `getDosttUserId()` fallback
**Returns:** `user_id, mobile_no`
Uses UNNEST + REGEXP_REPLACE to normalise phone (strips +91 prefix).

### Query 17564 — Points Data
**Parameters:** None (returns all LTV 500–1500 users)
**Used by:** `getOrRefreshPoints()` every 2 hours per user
**Returns:** `user_id, mobile_no, wallet_balance, spent_on_audio, spent_on_video, total_spent, last_refreshed_at_ist, ltv`
- `total_spent` = cumulative spend since go-live date (2026-04-20 18:30 IST)
- `ltv` = all-time spend (used for eligibility gate)
- Backend finds the specific user row by matching `dostt_user_id`

---

## Points & Cycle System

### How Points Work
```
rawTotalSpent     = total spend since go-live (from Redash 17564)
finalBaseline     = cycle_baseline_points (set at login / cycle reset)
adjustedTotalSpent = max(0, rawTotalSpent - finalBaseline)
```
Users see `adjustedTotalSpent` as their progress. This means:
- New user: starts at 0 even if they had historical spend
- After cycle reset: starts at 0 again from new baseline

### First Login Baseline
`auth.js` sets `cycle_baseline_points = 0` on first login.
On first Redash fetch, `getOrRefreshPoints` detects this and sets `cycle_baseline_points = rawTotalSpent`.
The same request uses `rawTotalSpent` directly as `finalBaseline` so `adjustedTotalSpent = 0` — user correctly starts at 0.

### Cycle Reset (Every 30 Days)
`getUserCycleStartDate()` checks `(now - cycle_start_date) >= 30 days`.
If expired: sets `cycle_start_date = now`, `cycle_baseline_points = rawTotalSpent`.
Writes a `cycle_reset` event to `points_audit`.

### `dostt_user_id` Flow
- Stored in `users.dostt_user_id` on login (from 17538)
- `getOrRefreshPoints`: reads from DB → no extra Redash call needed
- If missing (pre-migration user): falls back to calling 17538, saves to DB for next time

---

## Database Tables

### `users`
| Column | Type | Notes |
|---|---|---|
| phone | VARCHAR(20) | PK part |
| country_code | VARCHAR(10) | PK part, default '+91' |
| cycle_start_date | TIMESTAMPTZ | Set on first login |
| cycle_baseline_points | NUMERIC(14,2) | Raw spend at cycle start |
| dostt_user_id | VARCHAR(100) | From Redash 17538 at login |
| created_at | TIMESTAMPTZ | |

### `user_points`
| Column | Type | Notes |
|---|---|---|
| phone | VARCHAR(20) | Unique |
| user_id | VARCHAR(100) | Dostt user_id |
| wallet_balance | NUMERIC(14,2) | |
| spent_on_audio | NUMERIC(14,2) | |
| spent_on_video | NUMERIC(14,2) | |
| total_spent | NUMERIC(14,2) | **Adjusted** (baseline subtracted) |
| last_refreshed_at_ist | TIMESTAMPTZ | From Redash |
| ltv | NUMERIC(14,2) | All-time spend |
| updated_at | TIMESTAMPTZ | When backend last synced from Redash |

Cache: refreshed from Redash every 2 hours per user.

### `claimed_rewards`
| Column | Type | Notes |
|---|---|---|
| phone | VARCHAR(20) | |
| country_code | VARCHAR(10) | |
| dostt_user_id | VARCHAR(100) | |
| tier_id | INTEGER | 1–17 |
| unlock_at | INTEGER | Points threshold |
| coins_awarded | INTEGER | |
| cycle_start_date | DATE | Scopes claim to cycle |
| claimed_at | TIMESTAMPTZ | |

Unique constraint: `(phone, country_code, tier_id, cycle_start_date)` — prevents double claims.

### `claim_notifications`
Audit log of every claim attempt (pending → success/failed).
| Column | Notes |
|---|---|
| status | "pending" / "success" / "failed" |
| wallet_response | JSONB response from Dostt Wallet API |
| failure_reason | Error message if failed |

### `login_logs`
Every login attempt with status and error reason.

### `points_audit`
Every points fetch recorded for complaint investigation.
| Column | Notes |
|---|---|
| event | "first_fetch" / "refresh" / "cycle_reset" |
| raw_total_spent | From Redash |
| baseline_points | Subtracted baseline |
| adjusted_total_spent | What user sees |
| note | Human-readable calculation e.g. "raw 5000 − baseline 4000 = 1000" |

---

## Tier Data (identical in `app.js` and `rewards.js` — keep in sync)

| Tier | Unlock At | Coins |
|---|---|---|
| 1 | 200 | 20 |
| 2 | 400 | 20 |
| 3 | 700 | 20 |
| 4 | 1,000 | 30 |
| 5 | 1,400 | 30 |
| 6 | 1,900 | 30 |
| 7 | 2,500 | 40 |
| 8 | 3,200 | 40 |
| 9 | 4,000 | 50 |
| 10 | 4,900 | 50 |
| 11 | 6,100 | 60 |
| 12 | 7,600 | 60 |
| 13 | 9,600 | 70 |
| 14 | 12,100 | 70 |
| 15 | 15,350 | 80 |
| 16 | 19,350 | 80 |
| 17 | 24,350 | 90 |

**If tiers change: update both `app.js` AND `backend/src/routes/rewards.js`.**

---

## Test Phones
```
9500365660  — primary test phone
9988818731  — secondary test phone / demo phone
```
Defined in: `app.js`, `backend/src/routes/auth.js`, `backend/src/routes/rewards.js`
**If adding/removing test phones: update all three files.**

Test phone behaviour:
- Skip Redash 17538 verification on login
- Skip Redash 17564 points fetch — `totalSpent` always = 24350 (all tiers unlocked)
- Can use Direct Select mode (bypass points check on claim)
- Can use Dummy mode (claim logged but wallet not credited)

---

## Wallet Credit (`src/services/dosttWallet.js`)
Posts a CSV to the Dostt Wallet API:
```
user_id,coins
<dostt_user_id>,<tier.coins>
```
Headers: `x-n8n-auth-key`, `Content-Type: multipart/form-data`
Timeout: 20 seconds.

---

## Redash Client (`src/services/redash.js`)
Handles async job polling:
1. `POST /api/queries/:id/results` with `{ max_age, parameters }`
2. If Redash returns cached result → return immediately
3. If Redash returns job → poll `/api/jobs/:jobId` every 1s (30s timeout)
4. Fetch result from `/api/query_results/:resultId.json`

---

## Known Gotchas

1. **Cache busting** — bump `?v=` in `index.html` on every frontend deploy
2. **Tier data sync** — defined in two places; keep them identical
3. **Test phone list** — defined in three files; keep them identical
4. **Migration** — run `docker compose exec backend npm run migrate` after schema changes; safe to re-run
5. **17564 has no parameter** — returns all LTV 500–1500 users; backend finds the user by `dostt_user_id`
6. **WebKit input text** — OTP/phone inputs use `type="text" inputmode="numeric"`, not `type="number"`. `-webkit-text-fill-color` required in CSS for WebView visibility
7. **Sequential claiming** — users must claim tier N before tier N+1; enforced in frontend only
8. **LTV eligibility** — only users with `total_ltv BETWEEN 500 AND 1500` appear in 17564. Users outside this range see 0 points and all tiers locked.
