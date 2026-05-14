const express = require("express");
const db = require("../db/client");
const { runQuery }    = require("../services/redash");
const { creditCoins } = require("../services/dosttWallet");
const logger = require("../utils/logger");

const router = express.Router();

const TEST_PHONES     = ["9500365660", "9988818731"];
const MAX_TIER_POINTS = 24350;
const CYCLE_DAYS      = Number(process.env.CYCLE_DAYS || 30);
const CYCLE_MS        = CYCLE_DAYS * 24 * 60 * 60 * 1000;

const TIER_DATA = [
  { id: 1,  unlockAt: 200,   coins: 20 },
  { id: 2,  unlockAt: 400,   coins: 20 },
  { id: 3,  unlockAt: 700,   coins: 20 },
  { id: 4,  unlockAt: 1000,  coins: 30 },
  { id: 5,  unlockAt: 1400,  coins: 30 },
  { id: 6,  unlockAt: 1900,  coins: 30 },
  { id: 7,  unlockAt: 2500,  coins: 40 },
  { id: 8,  unlockAt: 3200,  coins: 40 },
  { id: 9,  unlockAt: 4000,  coins: 50 },
  { id: 10, unlockAt: 4900,  coins: 50 },
  { id: 11, unlockAt: 6100,  coins: 60 },
  { id: 12, unlockAt: 7600,  coins: 60 },
  { id: 13, unlockAt: 9600,  coins: 70 },
  { id: 14, unlockAt: 12100, coins: 70 },
  { id: 15, unlockAt: 15350, coins: 80 },
  { id: 16, unlockAt: 19350, coins: 80 },
  { id: 17, unlockAt: 24350, coins: 90 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

// Get user's current cycle start date as a DATE string ("YYYY-MM-DD")
// Resets the cycle automatically if 30 days have passed
async function getUserCycleStartDate(phone, countryCode, rawTotalSpent = null) {
  const user = await db.findOne("users", { phone, country_code: countryCode });
  if (!user) return null;

  const now = new Date();
  let cycleStart = user.cycle_start_date ? new Date(user.cycle_start_date) : null;

  if (!cycleStart) {
    // Should not happen (auth.js sets it on login), but handle gracefully
    cycleStart = now;
    await db.update("users", { phone, country_code: countryCode }, {
      cycle_start_date:      cycleStart,
      cycle_baseline_points: rawTotalSpent ?? 0,
    });
  } else if ((now - cycleStart) >= CYCLE_MS) {
    // 30 days passed → start new cycle, reset baseline to current raw spend
    cycleStart = now;
    await db.update("users", { phone, country_code: countryCode }, {
      cycle_start_date:      cycleStart,
      cycle_baseline_points: rawTotalSpent ?? user.cycle_baseline_points,
    });
    logger.info("cycle reset", { phone, newCycleStart: cycleStart });
  }

  // Return as DATE string "YYYY-MM-DD" — used as cycle scope in claimed_rewards
  return cycleStart.toISOString().split("T")[0];
}

// Get Dostt user_id from Redash. Tries cache first, retries fresh.
async function getDosttUserId(phone) {
  const queryId = Number(process.env.REDASH_VERIFY_PHONE_QUERY_ID);
  if (!queryId) return null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const rows = await runQuery(queryId, { mobile_numbers: phone }, attempt === 1 ? 3600 : 0);
      if (rows.length && rows[0].user_id) return rows[0].user_id;
    } catch (err) {
      logger.warn(`getDosttUserId attempt ${attempt} failed`, { phone, err: err.message });
    }
  }
  return null;
}

// Fetch points from Redash (or cache). Applies per-user cycle baseline subtraction.
async function getOrRefreshPoints(phone, countryCode) {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const cached = await db.findOne("user_points", { phone });

  if (cached && cached.updated_at && (Date.now() - new Date(cached.updated_at)) < TWO_HOURS) {
    return cached;
  }

  const queryId = Number(process.env.REDASH_USER_POINTS_QUERY_ID);
  if (!queryId) return cached;

  let rows;
  try {
    rows = await runQuery(queryId, { phone }, 0);
  } catch (err) {
    logger.warn("Redash points fetch failed, using cached data", { phone, err: err.message });
    return cached;
  }

  if (!rows || !rows.length) return cached;

  const r = rows[0];
  const rawTotalSpent = Number(r.total_spent) || 0;

  // Get user's cycle info (resets cycle if expired, passing raw spend as new baseline)
  await getUserCycleStartDate(phone, countryCode, rawTotalSpent);

  // Re-fetch user after possible cycle reset
  const user = await db.findOne("users", { phone, country_code: countryCode });
  const baseline = Number(user?.cycle_baseline_points) || 0;

  // If baseline was never set (first fetch after login), set it now
  if (user && (user.cycle_baseline_points === null || user.cycle_baseline_points === 0) && !cached) {
    await db.update("users", { phone, country_code: countryCode }, {
      cycle_baseline_points: rawTotalSpent,
    });
  }

  // Adjusted = what user earned SINCE joining rewards program (or since last cycle reset)
  const finalBaseline = user?.cycle_baseline_points != null ? Number(user.cycle_baseline_points) : rawTotalSpent;
  const adjustedTotalSpent = Math.max(0, rawTotalSpent - finalBaseline);

  await db.upsert("user_points", {
    user_id:               r.user_id               || null,
    phone,
    wallet_balance:        Number(r.wallet_balance)  || 0,
    spent_on_audio:        Number(r.spent_on_audio)  || 0,
    spent_on_video:        Number(r.spent_on_video)  || 0,
    total_spent:           adjustedTotalSpent,
    last_refreshed_at_ist: r.last_refreshed_at_ist   || null,
    ltv:                   Number(r.ltv)              || 0,
    updated_at:            new Date(),
  }, ["phone"]);

  return db.findOne("user_points", { phone });
}

// ── GET /rewards/me ───────────────────────────────────────────────────────────

router.get("/me", async (req, res) => {
  try {
    const { phone, countryCode = "+91" } = req.query;
    if (!phone) return res.status(400).json({ error: "phone is required" });

    const isTestPhone = TEST_PHONES.includes(phone);

    // Get user's personal cycle dates
    const user = await db.findOne("users", { phone, country_code: countryCode });
    const cycleStart = user?.cycle_start_date ? new Date(user.cycle_start_date) : new Date();
    const cycleEnd   = new Date(cycleStart.getTime() + CYCLE_MS);
    const cycleStartDateStr = cycleStart.toISOString().split("T")[0];

    const [points, claimedRows] = await Promise.all([
      getOrRefreshPoints(phone, countryCode),
      db.query(
        `SELECT tier_id FROM claimed_rewards
         WHERE phone = $1 AND country_code = $2 AND cycle_start_date = $3`,
        [phone, countryCode, cycleStartDateStr]
      ),
    ]);

    res.json({
      totalSpent:      isTestPhone ? MAX_TIER_POINTS : (points ? Number(points.total_spent) : 0),
      walletBalance:   points ? Number(points.wallet_balance) : 0,
      spentOnAudio:    points ? Number(points.spent_on_audio) : 0,
      spentOnVideo:    points ? Number(points.spent_on_video) : 0,
      ltv:             points ? Number(points.ltv) : 0,
      lastRefreshedAt: points ? points.last_refreshed_at_ist : null,
      claimedTiers:    claimedRows.map(r => r.tier_id),
      isTester:        isTestPhone,
      cycle: {
        startDate: cycleStart.toISOString(),
        endDate:   cycleEnd.toISOString(),
      },
    });
  } catch (err) {
    logger.error("rewards /me error", { err: err.message });
    res.status(500).json({ error: "Failed to fetch rewards" });
  }
});

// ── POST /rewards/claim ───────────────────────────────────────────────────────

router.post("/claim", async (req, res) => {
  try {
    const { phone, countryCode = "+91", claimMode = "api", claimType = "real" } = req.body;
    const tierId = Number(req.body.tierId);

    if (!phone) return res.status(400).json({ error: "phone is required" });

    const tier = TIER_DATA.find(t => t.id === tierId);
    if (!tier) return res.status(400).json({ error: "Invalid tierId" });

    const isTestPhone    = TEST_PHONES.includes(phone);
    const isDirectSelect = claimMode === "direct_select" && isTestPhone;
    const isDummy        = claimType === "dummy" && isTestPhone;

    // Get user's current cycle start date
    const cycleStartDateStr = await getUserCycleStartDate(phone, countryCode);
    if (!cycleStartDateStr) return res.status(400).json({ error: "User not found. Please login again." });

    // Guard: already claimed this cycle?
    const existing = await db.findOne("claimed_rewards", {
      phone,
      country_code:     countryCode,
      tier_id:          tierId,
      cycle_start_date: cycleStartDateStr,
    });
    if (existing) return res.status(409).json({ error: "Already claimed this cycle" });

    // Guard: enough points?
    const points     = await getOrRefreshPoints(phone, countryCode);
    const totalSpent = isTestPhone ? MAX_TIER_POINTS : (points ? Number(points.total_spent) : 0);
    if (!isDirectSelect && totalSpent < tier.unlockAt) {
      return res.status(403).json({
        error: `Not enough Dostt Points. Need ${tier.unlockAt}, have ${totalSpent}.`,
      });
    }

    // Resolve user_id
    const dosttUserId = isDummy ? null : await getDosttUserId(phone);
    if (!isDummy && !dosttUserId) {
      logger.error("claim blocked — could not resolve dostt user_id", { phone, tierId });
      return res.status(502).json({ error: "Could not resolve your Dostt account. Please try again." });
    }

    // Log attempt
    const notification = await db.insert("claim_notifications", {
      phone,
      country_code:   countryCode,
      dostt_user_id:  dosttUserId || null,
      tier_id:        tierId,
      tier_unlock_at: tier.unlockAt,
      coins_awarded:  tier.coins,
      cycle_number:   1, // kept for backward compat, not used for logic
      status:         "pending",
    });

    // Credit wallet
    let walletResponse = null;
    try {
      if (isDummy) {
        logger.info("dummy claim — skipping wallet credit", { phone, tierId });
      } else {
        walletResponse = await creditCoins(dosttUserId, tierId, tier.coins);
      }
      await db.update("claim_notifications", { id: notification.id }, {
        status:          "success",
        wallet_response: walletResponse ? JSON.stringify(walletResponse) : null,
      });
    } catch (walletErr) {
      await db.update("claim_notifications", { id: notification.id }, {
        status:         "failed",
        failure_reason: walletErr.message,
      });
      logger.error("Wallet credit failed", { phone, tierId, err: walletErr.message });
      return res.status(502).json({ error: "Failed to credit coins. Please try again." });
    }

    // Record successful claim
    const claimed = await db.insert("claimed_rewards", {
      phone,
      country_code:     countryCode,
      dostt_user_id:    dosttUserId || null,
      tier_id:          tierId,
      unlock_at:        tier.unlockAt,
      coins_awarded:    tier.coins,
      cycle_start_date: cycleStartDateStr,
    });

    logger.info("claim success", { phone, tierId, coins: tier.coins, cycle: cycleStartDateStr });
    res.json({ success: true, coinsAwarded: tier.coins, claimed });
  } catch (err) {
    logger.error("rewards /claim error", { err: err.message });
    res.status(500).json({ error: "Failed to claim reward" });
  }
});

module.exports = router;
