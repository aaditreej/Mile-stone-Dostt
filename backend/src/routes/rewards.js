const express = require("express");
const db = require("../db/client");
const { runQuery }    = require("../services/redash");
const { getCycleInfo } = require("../services/cycle");
const { creditCoins } = require("../services/dosttWallet");
const logger = require("../utils/logger");

const router = express.Router();

const TEST_PHONES = ["9500365660"];
const MAX_TIER_POINTS = 24350;
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

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

async function getOrRefreshPoints(phone, countryCode = "+91") {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const cached = await db.findOne("user_points", { mobile_no: phone });

  if (cached && cached.synced_at && (Date.now() - new Date(cached.synced_at)) < TWO_HOURS) {
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
    mobile_no:             phone,
    wallet_balance:        Number(r.wallet_balance)  || 0,
    spent_on_audio:        Number(r.spent_on_audio)  || 0,
    spent_on_video:        Number(r.spent_on_video)  || 0,
    total_spent:           Number(r.total_spent)      || 0,
    last_refreshed_at_ist: r.last_refreshed_at_ist   || null,
    ltv:                   Number(r.ltv)              || 0,
    synced_at:             new Date(),
  }, ["mobile_no"]);

  // Populate claims_pending for all tiers now unlocked — INSERT IGNORE if already recorded
  const totalSpentVal = Number(r.total_spent) || 0;
  const { cycleNumber } = getCycleInfo();
  const unlockedTiers = TIER_DATA.filter(t => totalSpentVal >= t.unlockAt);
  for (const tier of unlockedTiers) {
    try {
      await db.query(
        `INSERT INTO claims_pending
           (user_id, phone, country_code, tier_id, tier_unlock_at, coins, cycle_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (phone, country_code, tier_id, cycle_number) DO NOTHING`,
        [r.user_id || null, phone, countryCode, tier.id, tier.unlockAt, tier.coins, cycleNumber]
      );
    } catch (err) {
      logger.warn("claims_pending insert failed", { phone, tierId: tier.id, err: err.message });
    }
  }

  return db.findOne("user_points", { mobile_no: phone });
}

// GET /rewards/me?phone=...&countryCode=...
router.get("/me", async (req, res) => {
  try {
    const { phone, countryCode = "+91" } = req.query;
    if (!phone) return res.status(400).json({ error: "phone is required" });

    const { cycleNumber, cycleStartDate, cycleEndDate } = getCycleInfo();
    const isTestPhone = TEST_PHONES.includes(phone);

    const [points, claimedRows, user] = await Promise.all([
      getOrRefreshPoints(phone, countryCode),
      db.query(
        `SELECT tier_id FROM claimed_rewards
         WHERE phone = $1 AND country_code = $2 AND cycle_number = $3`,
        [phone, countryCode, cycleNumber]
      ),
      db.findOne("users", { phone, country_code: countryCode }),
    ]);

    res.json({
      totalSpent:      isTestPhone ? MAX_TIER_POINTS : (points ? Number(points.total_spent) : 0),
      walletBalance:   points ? Number(points.wallet_balance) : 0,
      spentOnAudio:    points ? Number(points.spent_on_audio) : 0,
      spentOnVideo:    points ? Number(points.spent_on_video) : 0,
      ltv:             points ? Number(points.ltv) : 0,
      lastRefreshedAt: points ? points.last_refreshed_at_ist : null,
      claimedTiers:    claimedRows.map(r => r.tier_id),
      nextClaimAt:     user?.next_claim_at || null,
      isTester:        isTestPhone,
      cycle: {
        number:    cycleNumber,
        startDate: cycleStartDate,
        endDate:   cycleEndDate,
      },
    });
  } catch (err) {
    logger.error("rewards /me error", { err: err.message });
    res.status(500).json({ error: "Failed to fetch rewards" });
  }
});

// POST /rewards/claim
// body: { phone, countryCode, tierId, claimMode, claimType }
//   claimMode: "api" (default) | "direct_select"  — direct_select skips points check (test phones only)
//   claimType: "real" (default) | "dummy"          — dummy skips wallet credit (test phones only)
router.post("/claim", async (req, res) => {
  try {
    const { phone, countryCode = "+91", claimMode = "api", claimType = "real" } = req.body;
    const tierId = Number(req.body.tierId);

    if (!phone) return res.status(400).json({ error: "phone is required" });

    const tier = TIER_DATA.find(t => t.id === tierId);
    if (!tier) return res.status(400).json({ error: "Invalid tierId" });

    const isTestPhone = TEST_PHONES.includes(phone);
    const isDirectSelect = claimMode === "direct_select" && isTestPhone;
    const isDummy = claimType === "dummy" && isTestPhone;

    const { cycleNumber } = getCycleInfo();

    // Guard: 1-hour global cooldown (skipped for test phones)
    const user = await db.findOne("users", { phone, country_code: countryCode });
    if (!isTestPhone && user?.next_claim_at && new Date(user.next_claim_at) > new Date()) {
      return res.status(429).json({
        error: "Claim cooldown active. Please wait before claiming again.",
        nextClaimAt: user.next_claim_at,
      });
    }

    // Guard: already claimed this cycle?
    const existing = await db.findOne("claimed_rewards", {
      phone,
      country_code: countryCode,
      tier_id: tierId,
      cycle_number: cycleNumber,
    });
    if (existing) {
      return res.status(409).json({ error: "Already claimed this cycle" });
    }

    // Guard: enough points? (skipped for direct_select test phones)
    const points = await getOrRefreshPoints(phone, countryCode);
    const totalSpent = isTestPhone ? MAX_TIER_POINTS : (points ? Number(points.total_spent) : 0);
    if (!isDirectSelect && totalSpent < tier.unlockAt) {
      return res.status(403).json({
        error: `Not enough Dostt Points. Need ${tier.unlockAt}, have ${totalSpent}.`,
      });
    }

    // Log claim attempt as pending
    const notification = await db.insert("claim_notifications", {
      phone,
      country_code:   countryCode,
      tier_id:        tierId,
      tier_unlock_at: tier.unlockAt,
      tier_coins:     tier.coins,
      cycle_number:   cycleNumber,
      coins_awarded:  tier.coins,
      claim_mode:     claimMode,
      claim_type:     claimType,
      dostt_user_id:  points?.user_id || null,
      status:         "pending",
    });

    let walletResponse = null;
    try {
      if (isDummy) {
        logger.info("dummy claim — skipping wallet credit", { phone, tierId, claimMode });
      } else if (isTestPhone) {
        logger.info("test phone — skipping wallet credit", { phone, tierId });
      } else {
        walletResponse = await creditCoins(points?.user_id || null, tierId, tier.coins);
      }

      await db.update("claim_notifications", { id: notification.id }, {
        status: "success",
        redash_response: walletResponse ? JSON.stringify(walletResponse) : null,
      });
    } catch (walletErr) {
      await db.update("claim_notifications", { id: notification.id }, {
        status: "failed",
        failure_reason: walletErr.message,
      });
      logger.error("Wallet coin credit failed", { phone, tierId, err: walletErr.message });
      return res.status(502).json({ error: "Failed to credit coins. Please try again." });
    }

    // Record in claimed_rewards
    const claimed = await db.insert("claimed_rewards", {
      phone,
      country_code:  countryCode,
      dostt_user_id: points?.user_id || null,
      tier_id:       tierId,
      unlock_at:     tier.unlockAt,
      coins_awarded: tier.coins,
      cycle_number:  cycleNumber,
    });

    // Move from claims_pending → claims_claimed
    try {
      const pending = await db.findOne("claims_pending", {
        phone,
        country_code: countryCode,
        tier_id:      tierId,
        cycle_number: cycleNumber,
      });

      await db.query(
        `INSERT INTO claims_claimed
           (user_id, phone, country_code, tier_id, tier_unlock_at, coins,
            cycle_number, became_claimable_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (phone, country_code, tier_id, cycle_number) DO NOTHING`,
        [
          points?.user_id || null,
          phone,
          countryCode,
          tierId,
          tier.unlockAt,
          tier.coins,
          cycleNumber,
          pending?.became_claimable_at || null,
        ]
      );

      await db.query(
        `DELETE FROM claims_pending
         WHERE phone = $1 AND country_code = $2 AND tier_id = $3 AND cycle_number = $4`,
        [phone, countryCode, tierId, cycleNumber]
      );
    } catch (err) {
      // Non-fatal — claimed_rewards is the source of truth
      logger.warn("claims_pending/claimed sync failed", { phone, tierId, err: err.message });
    }

    // Set 1-hour cooldown
    const nextClaimAt = new Date(Date.now() + COOLDOWN_MS).toISOString();
    await db.update("users", { phone, country_code: countryCode }, { next_claim_at: nextClaimAt });

    logger.info("claim success", { phone, tierId, claimMode, claimType, coins: tier.coins });
    res.json({ success: true, coinsAwarded: tier.coins, nextClaimAt, claimed });
  } catch (err) {
    logger.error("rewards /claim error", { err: err.message });
    res.status(500).json({ error: "Failed to claim reward" });
  }
});

module.exports = router;
