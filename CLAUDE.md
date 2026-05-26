# CLAUDE.md — Dostt Free Rewards: Complete Documentation

## What This Is
A WebView page embedded inside the Dostt app. Users earn "Dostt Points" by spending coins on audio/video calls, then claim free coin rewards at 17 milestone tiers. Resets every 30 days per user.

---

## Project Structure
```
/
├── index.html              ← Entry point (WebView loads this)
├── app.js                  ← Entire frontend (Vanilla JS SPA)
├── styles.css              ← Custom CSS + Tailwind overrides
├── assets/                 ← Images, Lottie JSON, audio
├── backend/
│   ├── src/
│   │   ├── index.js        ← Express entry point + daily audit cleanup
│   │   ├── routes/
│   │   │   ├── auth.js     ← POST /auth/login, GET /auth/verify
│   │   │   ├── rewards.js  ← GET /rewards/me, POST /rewards/claim
│   │   │   └── admin.js    ← GET /admin/* (reporting)
│   │   ├── db/
│   │   │   ├── client.js   ← Adapter selector
│   │   │   └── adapters/
│   │   │       ├── postgres.js
│   │   │       └── supabase.js
│   │   ├── services/
│   │   │   ├── redash.js       ← Redash API client (async job polling)
│   │   │   └── dosttWallet.js  ← Coin credit API
│   │   └── utils/logger.js
│   ├── scripts/migrate.js  ← DB migration (safe to re-run)
│   ├── Dockerfile
│   └── .env.example
├── k8s/                    ← Kubernetes manifests
│   ├── backend-deployment.yaml
│   ├── backend-service.yaml
│   ├── frontend-deployment.yaml
│   ├── frontend-service.yaml
│   ├── configmap.yaml
│   ├── secret.yaml
│   ├── ingress.yaml
│   └── postgres-statefulset.yaml
├── docker-compose.yml      ← Local dev only
└── Dockerfile              ← Frontend nginx image
```

---

## Architecture
```
Dostt App (WebView)
      │
      ▼
  index.html + app.js (Vanilla JS SPA, no build step)
      │
      │  HTTP (fetch)
      │  /auth/login
      │  /rewards/me
      │  /rewards/claim
      ▼
  Express Backend (Node.js)
      │
      ├──► PostgreSQL
      │      users
      │      user_points
      │      claimed_rewards
      │      claim_notifications
      │      login_logs
      │      points_audit
      │
      ├──► Redash (BigQuery)
      │      Query 17538 — verify phone, get user_id
      │      Query 17564 — single-user spend data (param: user_id)
      │
      └──► Dostt Wallet API
             Credits coins to user wallet on claim
```

---

## Environment Variables
```bash
PORT=3001
DB_ADAPTER=postgres                  # "postgres" | "supabase"
DATABASE_URL=postgres://...
CYCLE_DAYS=30

REDASH_BASE_URL=https://app.redash.io/yourslug
REDASH_API_KEY=...
REDASH_VERIFY_PHONE_QUERY_ID=17538   # phone → user_id
REDASH_USER_POINTS_QUERY_ID=17564    # single-user spend data (param: user_id)

DOSTT_WALLET_API_URL=https://api.dostt.in/payments/free-coins/upload/
DOSTT_WALLET_AUTH_KEY=...

ADMIN_API_KEY=...                    # x-admin-key header for /admin/*
```

---

# FRONTEND

## State Object
```js
const state = {
  view: "login",            // "login" | "rewards" | "terms"
  phone: "",
  country: COUNTRIES[0],    // { flag, name, code }

  // Seeded from localStorage on page load (stale-while-revalidate)
  totalSpent: Number(localStorage.getItem("dostt_totalSpent")) || 0,
  lastRefreshedAt: localStorage.getItem("dostt_lastRefreshedAt") || null,
  dataUpdatedAt:   localStorage.getItem("dostt_dataUpdatedAt")   || null,
  cycleEndDate:    localStorage.getItem("dostt_cycleEndDate")    || null,
  claimed: new Set(JSON.parse(localStorage.getItem("dostt_claimedTiers") || "[]")),

  claimingTiers: new Set(), // tier IDs with in-flight API calls
  dataLoading: localStorage.getItem("dostt_totalSpent") === null, // false when cache exists
  dataRefreshing: false,    // true while a background /rewards/me fetch is in flight
  toast: "",
  loading: false,

  // tester state
  isTester: false,
  testMode: null,           // null | "api" | "direct_select" | "bypass" | "real"
  claimType: "real",        // "real" | "dummy"
  showTestModal: false,
}
```

## localStorage Keys
| Key | Value | Cleared on |
|-----|-------|------------|
| `dostt_session` | `{ phone, country }` | logout |
| `dostt_totalSpent` | String number | logout |
| `dostt_claimedTiers` | JSON array of tier IDs | logout |
| `dostt_lastRefreshedAt` | Redash timestamp string | logout / null from server |
| `dostt_dataUpdatedAt` | ISO timestamp string | logout / null from server |
| `dostt_cycleEndDate` | ISO timestamp string | logout / null from server |
| `dostt_testMode` | `"api"` \| `"direct_select"` \| `"bypass"` \| `"real"` | logout |

## Frontend API Calls

### Login
```
POST /auth/login
Body: { phone, countryCode }
→ { success, user: { phone, countryCode }, isTester }
```
Called when user taps Login. On success: saves `{ phone, country }` to `dostt_session`,
navigates to rewards view, fires `loadRewardsData()` in background (non-blocking).

### Load Rewards Data
```
GET /rewards/me?phone=&countryCode=
→ {
    totalSpent, walletBalance, spentOnAudio, spentOnVideo,
    ltv, lastRefreshedAt, dataUpdatedAt,
    claimedTiers: [1, 3, 5],
    isTester,
    cycle: { startDate, endDate }
  }
```
Called on: login success, session restore, test mode selection, pull-to-refresh.

**Stale-while-revalidate pattern:**
- Does NOT set `dataLoading = true` at the start — cached data is already showing
- Sets `dataRefreshing = true` while the fetch is in flight
- Progress card shows "Syncing…" when `dataRefreshing`
- On success: updates state AND saves `dostt_totalSpent` + `dostt_claimedTiers` to localStorage
- In finally: sets `dataLoading = false` and `dataRefreshing = false`
- On failure: shows toast "Could not load rewards. Pull down to refresh."

All callers fire it without `await`:
```js
loadRewardsData().then(() => { render(); initLottie(); }).catch(() => {});
```

### Claim Reward
```
POST /rewards/claim
Body: { phone, countryCode, tierId, claimMode, claimType }
→ { success: true, coinsAwarded: 30, claimed: {...} }
```
`claimMode`: `"api"` (normal) | `"direct_select"` (test — skip points check)
`claimType`: `"real"` (credit wallet) | `"dummy"` (log only, test)

Error responses handled:
- 409 → `state.claimed.add(tierId)` silently (already claimed)
- Other → show error toast

## Tier Card Logic
```js
claimable = !state.dataLoading
         && (totalSpent >= tier.unlockAt || isDirectSelect)
         && !isClaimed
         && (tier.id === 1 || state.claimed.has(tier.id - 1))
         // ↑ sequential: must claim N-1 before N
```

## Claim Button States
| State | Button | Disabled |
|---|---|---|
| `dataLoading` | "Claim" grey | ✅ |
| `claimingTiers.has(id)` | "Claiming…" purple | ✅ |
| `claimed.has(id)` | "Claimed" grey | ✅ |
| `locked` (not enough points) | "Claim" grey | ✅ |
| `claimable` | "Claim" purple | ❌ |

## Double-Click Prevention
`state.claimingTiers.add(tierId)` → `render()` immediately on click.
Button stays locked through any number of re-renders until API resolves.
`state.claimingTiers.delete(tierId)` called in ALL code paths after API.

## Scroll Position
Before every `render()` on the rewards page:
- Saves `document.getElementById("page-scroll")?.scrollTop`
- Saves `document.querySelector(".reward-scroll")?.scrollTop`
- Restores both immediately after `root.innerHTML = rewardsPage()`

## Pull-to-Refresh
Touch events on `#page-scroll`. 65px threshold. Visual spinner in `#ptr-indicator`.
Guard: `!state.dataRefreshing` (not `!state.dataLoading`) — prevents double-fire while fetch is in flight.

## API Helper
```js
async function api(path, options = {})
// - 30s AbortController timeout
// - Throws with { status, data } on non-2xx
// - localhost → http://localhost:3001
// - production → /api
// - No auth headers (phone = identity, app is WebView-only)
```

## Session Persistence
`dostt_session` = `{ phone, country }`. On load:
- Non-tester: show rewards page immediately (dataLoading = false if cache exists), then validate session + load fresh data in parallel via `Promise.allSettled`
- Tester: restore `dostt_testMode` from localStorage, skip modal, load data in background

`clearSession()` removes ALL localStorage keys and resets state to initial values including `dataLoading = true`.

## Test Mode
```js
function setTestMode(mode) {
  state.testMode = mode;
  localStorage.setItem("dostt_testMode", mode); // persists across page reloads
}
```

| Mode | Behaviour |
|---|---|
| `api` | Hits backend normally, saves to DB, normal points check |
| `direct_select` | All tiers unlocked, hits backend, saves to DB |
| `bypass` | Fully offline, no API, no DB, resets on logout |
| `real` | Skips MAX_TIER_POINTS override, runs full Redash flow, shows actual spend |

## Cache Busting
`index.html` loads `app.js?v=YYYYMMDD-N` and `styles.css?v=YYYYMMDD-N`.
**Bump version on every frontend deploy.**

---

# BACKEND APIs

## POST /auth/login
**Body:** `{ phone, countryCode? }`

**Flow:**
```
1. Validate phone (regex: 7-15 digits)
2. If NOT test phone:
   a. Call Redash 17538 with { mobile_numbers: phone }
   b. If user not found → 403 "Please use your Dostt registered number"
   c. If Redash down → 503
3. Upsert users table (phone + country_code)
4. If first login (no cycle_start_date):
   - Set cycle_start_date = NOW()
   - Set cycle_baseline_points = -1  ← sentinel: "not yet confirmed by Redash"
5. Save dostt_user_id to users.dostt_user_id
6. Write to login_logs
7. Return { success, user, isTester }
```

**Responses:**
```
200 { success: true, user: { phone, countryCode }, isTester: false }
400 { error: "Invalid phone number" }
403 { error: "Please use your Dostt registered number" }
503 { error: "Verification service unavailable. Please try again." }
500 { error: "Login failed" }
```

---

## GET /auth/verify
**Query:** `?phone=&countryCode=`

Lightweight session re-validation used on page reload. Same Redash check as `/login` but:
- Writes NO `login_logs` entry
- Does NOT modify the `users` table
- On Redash error: allows session through (degraded mode, `{ valid: true, degraded: true }`)

---

## GET /rewards/me
**Query:** `?phone=&countryCode=&realMode=`

**Flow:**
```
1. getOrRefreshPoints(phone, countryCode, realMode)
   ↓ (hits Redash fresh, may reset cycle if 30 days passed)
2. Read cycle_start_date from DB (post-refresh so cycle reset is reflected)
3. Query claimed_rewards WHERE cycle_start_date = current cycle
4. Return combined response
```

**`getOrRefreshPoints` internals:**
```
- Test phone in non-real mode? → return cached immediately (no Redash call)
- Read dostt_user_id from users table
  - If null: call Redash 17538, save to DB for next time
- Call Redash 17564 with { user_id: dosttUserId }, max_age: 0 (always fresh BQ hit)
- If 0 rows (no spend data):
  - Still call getUserCycleStartDate(phone, countryCode, 0) — keeps cycle ticking
  - Write zero-row to user_points if none exists (prevents re-triggering first-fetch logic)
  - Return cached (0 points)
- Single row returned: rawTotalSpent = Number(r.total_spent)
- Call getUserCycleStartDate(phone, countryCode, rawTotalSpent)
  - Resets cycle if 30 days passed, updates baseline to rawTotalSpent
- Re-fetch user (post possible cycle reset)
- isFirstFetchBaseline = cycle_baseline_points IS NULL OR < 0
  - The -1 sentinel set at login triggers this on the very first successful Redash fetch
  - Check < 0 (not === -1) because pg returns NUMERIC as string "−1.00"
  - If true: set cycle_baseline_points = rawTotalSpent in DB
- adjustedTotalSpent = MAX(0, rawTotalSpent - finalBaseline)
- Upsert user_points table
- Write to points_audit
```

**Response:**
```json
{
  "totalSpent": 1250,
  "walletBalance": 450,
  "spentOnAudio": 800,
  "spentOnVideo": 450,
  "ltv": 1100,
  "lastRefreshedAt": "14/05/2026 18:30",
  "dataUpdatedAt": "2026-05-14T13:00:00.000Z",
  "claimedTiers": [1, 2, 3],
  "isTester": false,
  "cycle": {
    "startDate": "2026-04-20T00:00:00.000Z",
    "endDate":   "2026-05-20T00:00:00.000Z"
  }
}
```
Test phones in non-real mode always get `totalSpent = 24350`.

---

## POST /rewards/claim
**Body:** `{ phone, countryCode?, tierId, claimMode?, claimType?, realMode? }`

**Flow:**
```
1.  Validate phone (regex: 7-15 digits) and tierId (must exist in TIER_DATA)
2.  getOrRefreshPoints → refresh points and possibly reset cycle
3.  Read user from DB (post-refresh, cycle reset already reflected)
    → derive cycleStartDateStr from user.cycle_start_date
4.  Check claimed_rewards → if exists → 409
5.  Sequential check: tier N requires tier N-1 claimed (skipped for direct_select)
6.  Check totalSpent >= tier.unlockAt (skipped for direct_select)
7.  Resolve dostt_user_id:
    - Read from claimUser (already fetched in step 3, no extra DB call)
    - Fallback: call Redash 17538 if null (pre-migration users only), save to DB
8.  INSERT claim_notifications (status: "pending")
9.  INSERT claimed_rewards (unique constraint → 409 on race)  ← idempotency gate
10. Call Dostt Wallet API (POST CSV with user_id + coins)
    - On failure: DELETE claimed_rewards (rollback), UPDATE notification "failed", return 502
11. UPDATE claim_notifications (status: "success")
12. Return { success, coinsAwarded, claimed }
```
**Order matters:** `claimed_rewards` is inserted BEFORE the wallet call so a wallet failure can never leave coins credited without a DB record. On wallet failure the claim record is deleted so the user can retry.

**Rollback states:**
- Normal wallet failure → DELETE claimed_rewards succeeds → notification `"failed"` → user gets 502, can retry
- Wallet failure + DELETE also fails → notification `"failed_unrolled"` → CRITICAL log → user told to contact support. Ops must manually `DELETE FROM claimed_rewards WHERE id = <claimedId>` before the user can claim again.
- Race condition (23505 on INSERT claimed_rewards) → notification `"duplicate"` → 409 returned

**Responses:**
```
200 { success: true, coinsAwarded: 30, claimed: {...} }
400 { error: "Invalid phone number" | "Invalid tierId" | "User not found. Please login again." }
403 { error: "Not enough Dostt Points. Need X, have Y." }
409 { error: "Already claimed this cycle" }
502 { error: "Failed to credit coins." | "Account lookup failed. Please log out..." }
500 { error: "Failed to claim reward" }
```

---

# REDASH QUERIES

## Query 17538 — Phone Verification
**Parameter:** `{{ mobile_numbers }}`
**Called by:** `POST /auth/login` + `getDosttUserId()` fallback
**Returns:** `user_id, mobile_no`
Uses UNNEST + REGEXP_REPLACE to normalise phone (strips +91 prefix).
**Cache:** `max_age: 0` at login (always fresh), `max_age: 3600` in `getDosttUserId` fallback

## Query 17564 — Points Data (per-user, parameterized)
**Parameter:** `{{ user_id }}` (Dostt user_id)
**Called by:** `getOrRefreshPoints()` on every /rewards/me
**Returns:** `user_id, mobile_no, wallet_balance, spent_on_audio, spent_on_video, total_spent, last_refreshed_at_ist, ltv`
**Cache:** `max_age: 0` — always hits BigQuery fresh on every request

Source table: `dostt-c1d96.ref_tables.sourav_magre_free_rewards_user_ltv`
Refreshed every ~2h via BigQuery scheduled query.

Column meanings:
- `total_spent` = cumulative spend since go-live (2026-05-22 10:00 IST)
- `last_refreshed_at_ist` = DD/MM/YYYY HH:MM of user's latest booking update
- `ltv` = all-time spend (stored for reference, no LTV gate)

Backend reads `rows[0]` directly — single-user query always returns 1 row or 0 rows.

---

# POINTS & CYCLE SYSTEM

## Calculation
```
rawTotalSpent      = from Redash 17564 (cumulative spend since go-live)
finalBaseline      = users.cycle_baseline_points
adjustedTotalSpent = MAX(0, rawTotalSpent - finalBaseline)
```
User sees `adjustedTotalSpent`. This ensures:
- New user starts at 0 (not their historical spend before joining rewards)
- After 30-day reset: starts at 0 again

## First Login Baseline (−1 sentinel)
```
Login → cycle_baseline_points = -1   ← sentinel: "not yet confirmed"
First Redash fetch → isFirstFetchBaseline = (cycle_baseline_points < 0)
  → DB updated: cycle_baseline_points = rawTotalSpent
  → finalBaseline = rawTotalSpent (uses new value immediately, not stale -1)
  → adjustedTotalSpent = 0 ✓
```
Why `-1` and not `0`: A user with legitimate 0 pre-login spend would also have `cycle_baseline_points = 0` after the first fetch confirms it. Using `-1` as sentinel lets us distinguish "not yet confirmed" from "confirmed as 0" so subsequent fetches don't re-trigger the baseline-setting logic.

`isFirstFetchBaseline` checks `Number(cycle_baseline_points) < 0` (not `=== -1`) because pg returns NUMERIC columns as strings like `"-1.00"`.

## 30-Day Cycle Reset
`getUserCycleStartDate()` runs on every points fetch (including zero-spend users):
```
if (now - cycle_start_date) >= 30 days:
  cycle_start_date = now
  cycle_baseline_points = rawTotalSpent
  → write "cycle_reset" event to points_audit
```
Called with `rawTotalSpent = 0` even for zero-spend users so their cycle still resets on time.
Claims in new cycle: `claimed_rewards` scoped by `cycle_start_date` DATE column.

## IST Date Handling
```js
function toISTDateStr(date) {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().split("T")[0];
}
```
Used for all `cycle_start_date` DATE strings. Manual offset instead of `Intl` to avoid timezone data issues in minimal Node.js builds.

## dostt_user_id Flow
```
Login  → Redash 17538 called → user_id saved to users.dostt_user_id
/me    → read dostt_user_id from DB → call Redash 17564 → get spend row
         (if null: fallback to 17538, save to DB for next time)
/claim → read dostt_user_id from claimUser (already fetched) → credit wallet
         (if null: fallback to 17538)
```

---

# DATABASE TABLES

## users
```sql
phone                 VARCHAR(20)    -- PK part
country_code          VARCHAR(10)    -- PK part, default '+91'
cycle_start_date      TIMESTAMPTZ    -- set on first login
cycle_baseline_points NUMERIC(14,2)  -- -1 at first login; set to rawTotalSpent on first fetch
dostt_user_id         VARCHAR(100)   -- from Redash 17538 at login
created_at            TIMESTAMPTZ
UNIQUE (phone, country_code)
```

## user_points (live Redash cache — refreshed on every /me call)
```sql
phone                 VARCHAR(20)    -- UNIQUE
user_id               VARCHAR(100)   -- dostt user_id
wallet_balance        NUMERIC(14,2)
spent_on_audio        NUMERIC(14,2)
spent_on_video        NUMERIC(14,2)
total_spent           NUMERIC(14,2)  -- ADJUSTED (baseline subtracted)
last_refreshed_at_ist TEXT           -- "DD/MM/YYYY HH:MM" string from Redash
ltv                   NUMERIC(14,2)  -- all-time spend
updated_at            TIMESTAMPTZ    -- when backend last synced
```

## claimed_rewards
```sql
phone                 VARCHAR(20)
country_code          VARCHAR(10)
dostt_user_id         VARCHAR(100)
tier_id               INTEGER         -- 1-17
unlock_at             INTEGER         -- points threshold
coins_awarded         INTEGER
cycle_start_date      DATE            -- scopes claim to cycle (IST date string)
claimed_at            TIMESTAMPTZ
UNIQUE (phone, country_code, tier_id, cycle_start_date)
```
The unique constraint is the last line of defence against double claims (race condition → 23505 → 409).

## claim_notifications (audit log of every claim attempt)
```sql
phone, country_code, dostt_user_id
tier_id, tier_unlock_at, coins_awarded
status                VARCHAR(20)    -- "pending" | "success" | "failed" | "failed_unrolled" | "duplicate"
failure_reason        TEXT
wallet_response       JSONB          -- raw Dostt Wallet API response
created_at            TIMESTAMPTZ
```
Status meanings:
- `pending`         — inserted at start of claim; should never stay pending (indicates crash mid-flow)
- `success`         — wallet credited, claimed_rewards recorded
- `failed`          — wallet failed, claimed_rewards rolled back, user can retry
- `failed_unrolled` — wallet failed AND rollback failed; claimed_rewards row still exists, coins NOT credited; requires manual fix (delete claimed_rewards row by id in failure_reason)
- `duplicate`       — concurrent request raced; claimed_rewards unique constraint fired; 409 returned

## login_logs
```sql
phone, country_code, dostt_user_id
status                VARCHAR(10)    -- "success" | "failed"
error_reason          TEXT
created_at            TIMESTAMPTZ
```

## points_audit (for complaint investigation)
```sql
phone, country_code
event                 VARCHAR(30)    -- "first_fetch" | "refresh" | "cycle_reset" | "no_spend_data"
raw_total_spent       NUMERIC(14,2)  -- from Redash
baseline_points       NUMERIC(14,2)  -- subtracted
adjusted_total_spent  NUMERIC(14,2)  -- what user sees
cycle_start_date      DATE
note                  TEXT           -- e.g. "raw 5000 − baseline 4000 = 1000"
created_at            TIMESTAMPTZ
```
Pruned automatically: migration prunes on startup + `index.js` runs a daily `setInterval` to delete rows older than 90 days.

## DB Views (monitoring only, not used by API)
| View | Shows |
|---|---|
| `v_login_logs` | All login attempts ordered by date |
| `v_claim_logs` | All claim attempts ordered by date |
| `v_user_performance` | Per-user: logins, tiers claimed, coins earned |
| `v_eligible_not_claimed` | Users who unlocked a tier but haven't claimed it THIS cycle |
| `v_tier_status` | Per user per tier: claimed / eligible / locked |

---

# TIER DATA
Defined identically in `app.js` AND `backend/src/routes/rewards.js`. **Keep in sync.**

| Tier | Unlock At | Coins |
|------|-----------|-------|
| 1  | 200    | 20 |
| 2  | 400    | 20 |
| 3  | 700    | 20 |
| 4  | 1,000  | 30 |
| 5  | 1,400  | 30 |
| 6  | 1,900  | 30 |
| 7  | 2,500  | 40 |
| 8  | 3,200  | 40 |
| 9  | 4,000  | 50 |
| 10 | 4,900  | 50 |
| 11 | 6,100  | 60 |
| 12 | 7,600  | 60 |
| 13 | 9,600  | 70 |
| 14 | 12,100 | 70 |
| 15 | 15,350 | 80 |
| 16 | 19,350 | 80 |
| 17 | 24,350 | 90 |

---

# TEST PHONES
```
9988818731   tester / demo
```
Defined in THREE files — update all three together:
- `app.js`
- `backend/src/routes/auth.js`
- `backend/src/routes/rewards.js`

Test phone behaviour:
- Skip Redash 17538 verification on login
- In non-real modes: `totalSpent` always = 24350 (all tiers unlocked), Redash 17564 not called
- In **real mode**: full Redash flow runs, shows actual spend from BigQuery
- Test mode is persisted to `dostt_testMode` localStorage so it survives page reloads
- `clearSession()` removes `dostt_testMode` so the modal re-appears on next login

To reset test phone claims (DB):
```sql
DELETE FROM claimed_rewards WHERE phone = '9988818731';
```

---

# WALLET CREDIT (dosttWallet.js)
Posts a CSV to the Dostt Wallet API:
```
user_id,coins
<dostt_user_id>,<tier.coins>
```
Headers: `x-n8n-auth-key`, multipart/form-data
Timeout: 20 seconds
Used only in `POST /rewards/claim` after all checks pass.

---

# RUNNING LOCALLY
```bash
# Frontend
python3 -m http.server 8080   # → http://localhost:8080

# Backend + DB
docker compose up -d

# First-time DB setup (or after schema changes)
docker compose exec backend npm run migrate

# Backend dev with hot reload
cd backend && npm run dev

# pgAdmin
# → http://localhost:5050  (admin@dostt.com / admin)

# Clear test phone claims (reset to tier 1)
docker compose exec postgres psql -U dostt -d dostt_rewards \
  -c "DELETE FROM claimed_rewards WHERE phone = '9988818731';"
```

---

# DEPLOYING TO KUBERO

Kubero is a PaaS on top of Kubernetes. You deploy apps via its dashboard or CLI, backed by the K8s manifests in `k8s/`.

## Step 1 — Build & Push Docker Images

You need two images: backend and frontend.

```bash
# Backend image
docker build -t your-registry/dostt-backend:latest ./backend
docker push your-registry/dostt-backend:latest

# Frontend image (nginx serving static files)
docker build -t your-registry/dostt-frontend:latest .
docker push your-registry/dostt-frontend:latest
```
Replace `your-registry` with your container registry (Docker Hub, GHCR, etc.).

## Step 2 — Update Image References
In `k8s/backend-deployment.yaml`:
```yaml
image: your-registry/dostt-backend:latest
```
In `k8s/frontend-deployment.yaml`:
```yaml
image: your-registry/dostt-frontend:latest
```

## Step 3 — Set Secrets
All sensitive values go in `k8s/secret.yaml`. Values must be base64-encoded:
```bash
echo -n "your-value" | base64
```
Fill in:
```yaml
DATABASE_URL:                    # postgres://user:pass@host:5432/dostt_rewards
REDASH_BASE_URL:                 # https://app.redash.io/yourslug
REDASH_API_KEY:                  # your Redash API key
REDASH_VERIFY_PHONE_QUERY_ID:    # 17538
REDASH_USER_POINTS_QUERY_ID:     # 17564
DOSTT_WALLET_API_URL:            # https://api.dostt.in/payments/free-coins/upload/
DOSTT_WALLET_AUTH_KEY:           # your x-n8n-auth-key
ADMIN_API_KEY:                   # long random string
```
**Do NOT commit real secret values to git.**

## Step 4 — Set Domain in Ingress
In `k8s/ingress.yaml`:
```yaml
host: rewards.dostt.in   # your actual domain
```

## Step 5 — Database
**Option A (recommended for production):** Use a managed Postgres (AWS RDS, GCP Cloud SQL, Supabase).
Set `DATABASE_URL` in secrets to point to it. Do NOT deploy `postgres-statefulset.yaml`.

**Option B (self-hosted):** Deploy the Postgres StatefulSet:
```bash
kubectl apply -f k8s/postgres-statefulset.yaml
```

## Step 6 — Apply All Manifests
```bash
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/secret.yaml
kubectl apply -f k8s/backend-deployment.yaml
kubectl apply -f k8s/backend-service.yaml
kubectl apply -f k8s/frontend-deployment.yaml
kubectl apply -f k8s/frontend-service.yaml
kubectl apply -f k8s/ingress.yaml
```

## Step 7 — Run Migrations
Once the backend pod is running:
```bash
kubectl exec -it $(kubectl get pod -l app=dostt-backend -o jsonpath='{.items[0].metadata.name}') \
  -- npm run migrate
```

## Step 8 — Verify
```bash
# Check all pods are running
kubectl get pods

# Check backend health
kubectl port-forward svc/dostt-backend-svc 3001:3001
curl http://localhost:3001/health   # → { "status": "ok" }

# Check logs
kubectl logs -l app=dostt-backend --tail=50
```

## Kubero-Specific (via Dashboard)
If using Kubero's UI instead of raw kubectl:
1. Create a new **App** in Kubero
2. Set the Git repo + branch
3. Set build command: `docker build`
4. Set environment variables from `secret.yaml` values in the Kubero env section
5. Set the domain to `rewards.dostt.in`
6. After first deploy, open the terminal in Kubero and run `npm run migrate`

---

# KNOWN GOTCHAS

1. **Cache busting** — bump `?v=` in `index.html` on every frontend deploy
2. **Tier data sync** — defined in two places (`app.js` + `rewards.js`); keep identical
3. **Test phone list** — defined in three files; keep identical
4. **Migration** — run after every schema change; safe to re-run (IF NOT EXISTS throughout)
5. **17564 is parameterized + always fresh** — `max_age: 0` means every `/rewards/me` hits BigQuery. BQ table refreshes every ~2h, so points update as fast as BQ does. No Redash result caching.
6. **No LTV gate** — all Dostt users are in the table; users with zero spend since go-live get 0 points (correct)
7. **WebKit input** — phone input uses `type="text" inputmode="numeric"` not `type="number"`; `-webkit-text-fill-color` required in CSS for WebView visibility
8. **Sequential claiming** — enforced on BOTH frontend and backend; tier N requires tier N-1 claimed first. `direct_select` test mode bypasses the backend sequential check.
9. **Scroll restore** — `id="page-scroll"` on outer div and class `reward-scroll` on tier list are used to save/restore scroll positions; don't remove these IDs
10. **points_audit / login_logs auto-pruned** — migration deletes rows older than 90 days on startup; `index.js` also runs a daily `setInterval` for the same. No manual cleanup needed.
11. **no_spend_data audit event** — when a user has no rows in the points table (zero spend since go-live), a `"no_spend_data"` event is written to `points_audit`. If a user reports 0 points and all tiers locked, check this table first.
12. **Stale localStorage cache** — `dostt_totalSpent` and `dostt_claimedTiers` are shown immediately on page load before the background fetch completes. This is intentional (no lag). After the fetch, state updates. If a cycle just reset or a claim was made on another device, users will see the stale data for ~2–5 seconds until the fetch resolves.
13. **pg NUMERIC → string** — PostgreSQL's `pg` driver returns `NUMERIC` columns as strings (e.g. `"200.00"`, `"-1.00"`). Always wrap with `Number()` before arithmetic or comparisons. This applies to `cycle_baseline_points`, `total_spent`, `wallet_balance`, etc.
14. **Test phone real mode showing stale data** — if real mode shows unexpected points, the old backend (pre `max_age:0` fix) may still be deployed. Redash caches last known data for up to 2h. After deploying the latest backend, real mode always hits BigQuery fresh.
