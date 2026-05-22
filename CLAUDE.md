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
│   │   ├── index.js        ← Express entry point
│   │   ├── routes/
│   │   │   ├── auth.js     ← POST /auth/login
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
      │      Query 17546 — single-user spend data (param: user_id)
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
REDASH_USER_POINTS_QUERY_ID=17546    # single-user spend data (param: user_id)

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
  totalSpent: 0,            // adjusted points for current cycle
  lastRefreshedAt: null,    // Redash last_refreshed_at_ist
  dataUpdatedAt: null,      // user_points.updated_at
  cycleEndDate: null,       // ISO string
  claimed: new Set(),       // tier IDs claimed this cycle
  claimingTiers: new Set(), // tier IDs with in-flight API calls
  dataLoading: true,        // blocks UI until /rewards/me returns
  toast: "",
  isTester: false,
  testMode: null,           // null | "api" | "direct_select" | "bypass"
  claimType: "real",        // "real" | "dummy"
  showTestModal: false,
}
```

## Frontend API Calls

### Login
```
POST /auth/login
Body: { phone, countryCode }
→ { success, user: { phone, countryCode }, isTester }
```
Called when user taps Login. On success: saves `{ phone, country }` to `localStorage("dostt_session")`, navigates to rewards view.

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
Called on: login success, session restore, test mode selection.
Sets `state.dataLoading = true` at start, `false` in finally.
On failure: shows toast "Could not load rewards. Pull down to refresh."

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
`localStorage("dostt_session")` = `{ phone, country }`
On load: if exists → skip login → show rewards → load data in background.
Test phones on session restore → show test mode modal.

## Test Phones
```js
const TEST_PHONES = ["9500365660", "9988818731"];
```
- Skip Redash verification on login
- Always get `totalSpent = 24350` (all tiers unlocked)
- Test modal: API / Direct Select / Bypass modes

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
   - Set cycle_baseline_points = 0
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

## GET /rewards/me
**Query:** `?phone=&countryCode=`

**Flow:**
```
1. getOrRefreshPoints(phone, countryCode)
   ↓ (may reset cycle if 30 days passed)
2. Read cycle_start_date from DB (post-refresh)
3. Query claimed_rewards WHERE cycle_start_date = current cycle
4. Return combined response
```

**`getOrRefreshPoints` internals:**
```
- Test phone? → return cached immediately (no Redash)
- Cache < 2h? → return cached
- Read dostt_user_id from users table
  - If null: call Redash 17538, save to DB for next time
- Call Redash 17546 with { user_id: dosttUserId } → 1 row for this user
- If 0 rows: user has no spend data yet → return cached (0 points)
- Apply baseline: adjustedSpent = rawTotalSpent - cycle_baseline_points
- If first fetch (no cache + baseline=0): set baseline = rawTotalSpent
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
Test phones always get `totalSpent = 24350`.

---

## POST /rewards/claim
**Body:** `{ phone, countryCode?, tierId, claimMode?, claimType? }`

**Flow:**
```
1.  Validate tierId (must exist in TIER_DATA)
2.  getUserCycleStartDate → get current cycle DATE string
3.  Check claimed_rewards → if exists → 409
4.  Sequential check: tier N requires tier N-1 claimed (skipped for direct_select)
5.  getOrRefreshPoints → check points
6.  If !isDirectSelect && totalSpent < tier.unlockAt → 403
7.  Resolve dostt_user_id:
    - Read from users table (fast, no Redash)
    - Fallback: call Redash 17538 if null (pre-migration users only), save to DB
8.  INSERT claim_notifications (status: "pending")
9.  INSERT claimed_rewards (unique constraint → 409 on race)  ← idempotency gate
10. Call Dostt Wallet API (POST CSV with user_id + coins)
    - On failure: DELETE claimed_rewards (rollback), UPDATE notification "failed", return 502
11. UPDATE claim_notifications (status: "success")
12. Return { success, coinsAwarded, claimed }
```
**Order matters:** claimed_rewards is inserted BEFORE the wallet call so a wallet failure can never leave coins credited without a DB record. On wallet failure the claim record is deleted so the user can retry.

**Rollback states:**
- Normal wallet failure → DELETE claimed_rewards succeeds → notification status `"failed"` → user gets 502, can retry
- Wallet failure + DELETE also fails → notification status `"failed_unrolled"` → CRITICAL log → user told to contact support (not retry). Ops must manually `DELETE FROM claimed_rewards WHERE id = <claimedId>` before the user can claim again.
- Race condition (23505 on INSERT claimed_rewards) → notification status `"duplicate"` → 409 returned

**Responses:**
```
200 { success: true, coinsAwarded: 30, claimed: {...} }
400 { error: "phone is required" | "Invalid tierId" | "User not found" }
403 { error: "Not enough Dostt Points. Need X, have Y." }
409 { error: "Already claimed this cycle" }
502 { error: "Failed to credit coins." | "Could not resolve Dostt account." }
500 { error: "Failed to claim reward" }
```

---

# REDASH QUERIES

## Query 17538 — Phone Verification
**Parameter:** `{{ mobile_numbers }}`
**Called by:** `POST /auth/login` + `getDosttUserId()` fallback
**Returns:** `user_id, mobile_no`
Uses UNNEST + REGEXP_REPLACE to normalise phone (strips +91 prefix).
**Cache:** `max_age: 0` at login (always fresh), `max_age: 3600` in getDosttUserId

## Query 17546 — Points Data (per-user)
**Parameter:** `{{ user_id }}` (Dostt user_id)
**Called by:** `getOrRefreshPoints()` on every /rewards/me
**Returns:** `user_id, mobile_no, wallet_balance, spent_on_audio, spent_on_video, total_spent, last_refreshed_at_ist, ltv`
**Cache:** `max_age: 7200` — matches the 2h BigQuery table refresh cadence

Source table: `dostt-c1d96.ref_tables.sourav_magre_free_rewards_user_ltv`
Refreshed every 2h via BigQuery scheduled query.

Column meanings:
- `total_spent` = cumulative spend since go-live (2026-05-22 10:00 IST)
- `last_refreshed_at_ist` = DD/MM/YYYY HH:MM of user's latest booking update
- `ltv` = all-time spend (stored for reference, no LTV gate anymore)

Backend reads `rows[0]` directly — single-user query always returns 1 row or 0 rows.

---

# POINTS & CYCLE SYSTEM

## Calculation
```
rawTotalSpent      = from Redash 17564 (spend since go-live)
finalBaseline      = users.cycle_baseline_points
adjustedTotalSpent = MAX(0, rawTotalSpent - finalBaseline)
```
User sees `adjustedTotalSpent`. This ensures:
- New user starts at 0 (not their historical spend)
- After 30-day reset: starts at 0 again

## First Login Baseline
```
Login → cycle_baseline_points = 0
First Redash fetch → isFirstFetchBaseline = true
  → DB updated: cycle_baseline_points = rawTotalSpent
  → finalBaseline = rawTotalSpent (uses new value, not stale 0)
  → adjustedTotalSpent = 0 ✓
```

## 30-Day Cycle Reset
`getUserCycleStartDate()` runs on every points fetch:
```
if (now - cycle_start_date) >= 30 days:
  cycle_start_date = now
  cycle_baseline_points = rawTotalSpent
  → write "cycle_reset" event to points_audit
```
Claims in new cycle: `claimed_rewards` scoped by `cycle_start_date` DATE column.

## dostt_user_id Flow
```
Login  → 17538 called → user_id saved to users.dostt_user_id
/me    → read dostt_user_id from DB → call 17564 → find user row
         (if null: fallback to 17538, save to DB for next time)
/claim → read dostt_user_id from DB → credit wallet
         (if null: fallback to 17538)
```

---

# DATABASE TABLES

## users
```sql
phone                 VARCHAR(20)    -- PK part
country_code          VARCHAR(10)    -- PK part, default '+91'
cycle_start_date      TIMESTAMPTZ    -- set on first login
cycle_baseline_points NUMERIC(14,2)  -- raw spend at cycle start
dostt_user_id         VARCHAR(100)   -- from Redash 17538 at login
created_at            TIMESTAMPTZ
UNIQUE (phone, country_code)
```

## user_points (2h cache of Redash data)
```sql
phone                 VARCHAR(20)    -- UNIQUE
user_id               VARCHAR(100)   -- dostt user_id
wallet_balance        NUMERIC(14,2)
spent_on_audio        NUMERIC(14,2)
spent_on_video        NUMERIC(14,2)
total_spent           NUMERIC(14,2)  -- ADJUSTED (baseline subtracted)
last_refreshed_at_ist TIMESTAMPTZ    -- from Redash
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
cycle_start_date      DATE            -- scopes claim to cycle
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
event                 VARCHAR(30)    -- "first_fetch" | "refresh" | "cycle_reset"
raw_total_spent       NUMERIC(14,2)  -- from Redash
baseline_points       NUMERIC(14,2)  -- subtracted
adjusted_total_spent  NUMERIC(14,2)  -- what user sees
cycle_start_date      DATE
note                  TEXT           -- e.g. "raw 5000 − baseline 4000 = 1000"
created_at            TIMESTAMPTZ
```

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
9500365660   primary tester
9988818731   secondary tester / demo
```
Defined in THREE files — update all three together:
- `app.js`
- `backend/src/routes/auth.js`
- `backend/src/routes/rewards.js`

Test phone behaviour:
- Skip 17538 verification on login
- Skip 17564 Redash fetch — `totalSpent` always = 24350
- Can use Direct Select (bypass points check)
- Can use Dummy mode (claim logged, wallet NOT credited)

---

# WALLET CREDIT (dosttWallet.js)
Posts a CSV to the Dostt Wallet API:
```
user_id,coins
<dostt_user_id>,<tier.coins>
```
Headers: `x-n8n-auth-key`, multipart/form-data
Timeout: 20 seconds
Used only in `POST /rewards/claim` after existing checks pass.

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
  -c "DELETE FROM claimed_rewards WHERE phone IN ('9500365660', '9988818731');"
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
2. **Tier data sync** — defined in two places; keep identical
3. **Test phone list** — defined in three files; keep identical
4. **Migration** — run after every schema change; safe to re-run (IF NOT EXISTS throughout)
5. **17546 is parameterized** — pass `user_id` and get 1 row back; reads from pre-materialized BigQuery table refreshed every 2h
6. **No LTV gate** — all Dostt users are in the table; users with zero spend since go-live get 0 points (correct)
7. **WebKit input** — phone input uses `type="text" inputmode="numeric"` not `type="number"`; `-webkit-text-fill-color` required in CSS for WebView visibility
8. **Sequential claiming** — enforced on BOTH frontend and backend; tier N requires tier N-1 claimed first. `direct_select` test mode bypasses the backend check.
9. **Scroll restore** — `id="page-scroll"` on outer div and class `reward-scroll` on tier list are used to save/restore scroll; don't remove these
10. **claim_notifications / points_audit grow unboundedly** — no TTL or archival. Schedule a periodic cleanup job (e.g. DELETE rows older than 90 days) before table size becomes a problem.
11. **no_spend_data audit** — when a user has no rows in the points table (zero spend since go-live), a `"no_spend_data"` event is written to `points_audit`. If a user reports 0 points and all tiers locked, check this table first.
