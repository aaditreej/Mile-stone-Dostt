const express = require("express");
const db = require("../db/client");
const { runQuery }     = require("../services/redash");
const { getCycleInfo } = require("../services/cycle");
const { creditCoins }  = require("../services/dosttWallet");
const logger = require("../utils/logger");

const router = express.Router();

const TEST_PHONES    = ["9500365660", "9988818731"];
const MAX_TIER_POINTS = 24350;

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

// Get Dostt user_id from Redash (same query as login).
// Tries cached result first (fast), retries fresh if cache misses.
async function getDosttUserId(phone) {
  const queryId = Number(process.env.REDASH_VERIFY_PHONE_QUERY_ID);
  if (!queryId) return null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const maxAge = attempt === 1 ? 3600 : 0;
      const rows = await runQuery(queryId, { mobile_numbers: phone }, maxAge);
      if (rows.length && rows[0].user_id) return rows[0].user_id;
    } catch (err) {
      logger.warn(`getDosttUserId attempt ${attempt} failed`, { phone, err: err.message });
    }
  }
  return null;
}

// Fetch user points from cache; refresh from Redash if older than 2 hours.
async function getOrRefreshPoints(phone) {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const cached = await db.findOne("user_points", { phone: phone });

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
  await db.upsert("user_points", {
    user_id:               r.user_id               || null,
    phone:             phone,
    wallet_balance:        Number(r.wallet_balance)  || 0,
    spent_on_audio:        Number(r.spent_on_audio)  || 0,
    spent_on_video:        Number(r.spent_on_video)  || 0,
    total_spent:           Number(r.total_spent)      || 0,
    last_refreshed_at_ist: r.last_refreshed_at_ist   || null,
    ltv:                   Number(r.ltv)              || 0,
    updated_at:             new Date(),
  }, ["phone"]);

  return db.findOne("user_points", { phone: phone });
}

// ── GET /rewards/me ───────────────────────────────────────────────────────────

router.get("/me", async (req, res) => {
  try {
    const { phone, countryCode = "+91" } = req.query;
    if (!phone) return res.status(400).json({ error: "phone is required" });

    const { cycleNumber, cycleStartDate, cycleEndDate } = getCycleInfo();
    const isTestPhone = TEST_PHONES.includes(phone);

    const [points, claimedRows] = await Promise.all([
      getOrRefreshPoints(phone),
      db.query(
        `SELECT tier_id FROM claimed_rewards
         WHERE phone = $1 AND country_code = $2 AND cycle_number = $3`,
        [phone, countryCode, cycleNumber]
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
      cycle: { number: cycleNumber, startDate: cycleStartDate, endDate: cycleEndDate },
    });
  } catch (err) {
    logger.error("rewards /me error", { err: err.message });
    res.status(500).json({ error: "Failed to fetch rewards" });
  }
});

// ── POST /rewards/claim ───────────────────────────────────────────────────────
// body: { phone, countryCode, tierId, claimMode, claimType }
//   claimMode: "api" | "direct_select"  — direct_select skips points check (test phones only)
//   claimType: "real" | "dummy"          — dummy skips wallet credit (test phones only)

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

    const { cycleNumber } = getCycleInfo();

    // Guard: already claimed?
    const existing = await db.findOne("claimed_rewards", {
      phone, country_code: countryCode, tier_id: tierId, cycle_number: cycleNumber,
    });
    if (existing) return res.status(409).json({ error: "Already claimed this cycle" });

    // Guard: enough points?
    const points     = await getOrRefreshPoints(phone);
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

    // Log attempt as pending
    const notification = await db.insert("claim_notifications", {
      phone,
      country_code:   countryCode,
      dostt_user_id:  dosttUserId || null,
      tier_id:        tierId,
      tier_unlock_at: tier.unlockAt,
      coins_awarded:  tier.coins,
      cycle_number:   cycleNumber,
      claim_mode:     claimMode,
      claim_type:     claimType,
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
      country_code:  countryCode,
      dostt_user_id: dosttUserId || null,
      tier_id:       tierId,
      unlock_at:     tier.unlockAt,
      coins_awarded: tier.coins,
      cycle_number:  cycleNumber,
    });

    logger.info("claim success", { phone, tierId, claimMode, claimType, coins: tier.coins });
    res.json({ success: true, coinsAwarded: tier.coins, claimed });
  } catch (err) {
    logger.error("rewards /claim error", { err: err.message });
    res.status(500).json({ error: "Failed to claim reward" });
  }
});

module.exports = router;
