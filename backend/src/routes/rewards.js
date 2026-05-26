const express = require("express");
const db = require("../db/client");
const { runQuery }    = require("../services/redash");
const { creditCoins } = require("../services/dosttWallet");
const logger = require("../utils/logger");

const router = express.Router();

// ⚠️ Also defined in: app.js (line ~71) and routes/auth.js (line ~8) — keep all three in sync
const TEST_PHONES     = ["9988818731"];
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
    // Audit the reset
    const newCycleStr = cycleStart.toISOString().split("T")[0];
    db.insert("points_audit", {
      phone,
      country_code:         countryCode,
      event:                "cycle_reset",
      raw_total_spent:      rawTotalSpent ?? 0,
      baseline_points:      rawTotalSpent ?? 0,
      adjusted_total_spent: 0,
      cycle_start_date:     newCycleStr,
      note:                 `new cycle started; new baseline = ${rawTotalSpent}`,
    }).catch(() => {});
  }

  // Return as DATE string "YYYY-MM-DD" — used as cycle scope in claimed_rewards
  return cycleStart.toISOString().split("T")[0];
}

// Get Dostt user_id from Redash. Tries cache first, retries fresh.
// realMode=true: skip cache on first attempt so testers always get a live lookup.
async function getDosttUserId(phone, realMode = false) {
  const queryId = Number(process.env.REDASH_VERIFY_PHONE_QUERY_ID);
  if (!queryId) return null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const maxAge = (realMode || attempt > 1) ? 0 : 3600;
      const rows = await runQuery(queryId, { mobile_numbers: phone }, maxAge);
      if (rows.length && rows[0].user_id) return rows[0].user_id;
    } catch (err) {
      logger.warn(`getDosttUserId attempt ${attempt} failed`, { phone, err: err.message });
    }
  }
  return null;
}

// Fetch points from Redash (or cache). Applies per-user cycle baseline subtraction.
// realMode=true: even for test phones, run the full Redash flow and return real data.
async function getOrRefreshPoints(phone, countryCode, realMode = false) {
  const cached = await db.findOne("user_points", { phone });

  // Test phones in non-real mode: totalSpent is overridden to MAX_TIER_POINTS in /me,
  // so skip the Redash call entirely and return cached (or null) immediately.
  if (TEST_PHONES.includes(phone) && !realMode) return cached;

  const queryId = Number(process.env.REDASH_USER_POINTS_QUERY_ID);
  if (!queryId) return cached;

  // Resolve dostt_user_id — read from DB (stored at login), fall back to 17538 for users
  // who logged in before the dostt_user_id column was added
  const userRecord = await db.findOne("users", { phone, country_code: countryCode });
  let dosttUserId = userRecord?.dostt_user_id;
  if (!dosttUserId) {
    logger.info("dostt_user_id missing in DB, falling back to 17538 lookup", { phone });
    dosttUserId = await getDosttUserId(phone, realMode);
    if (dosttUserId) {
      // Save it so future fetches skip the Redash call
      await db.update("users", { phone, country_code: countryCode }, { dostt_user_id: dosttUserId });
    } else {
      logger.warn("could not resolve dostt_user_id, skipping points fetch", { phone });
      return cached;
    }
  }

  let rows;
  try {
    // Query 17564: SELECT … FROM sourav_magre_free_rewards_user_ltv WHERE user_id = {{ user_id }}
    // max_age: 0 — always hit BigQuery fresh; no Redash result cache for any user.
    rows = await runQuery(queryId, { user_id: dosttUserId }, 0);
  } catch (err) {
    logger.warn("Redash points fetch failed, using cached data", { phone, err: err.message });
    return cached;
  }

  if (!rows || !rows.length) {
    // User has no spend data yet (new user with zero history, or no bookings since go-live).
    // IMPORTANT: still write a zero user_points row if none exists. Without this, every future
    // fetch would see cached=null and treat itself as "first fetch", incorrectly setting the
    // baseline to the user's first actual spend (so they'd see 0 instead of their real points).
    if (!cached) {
      await db.upsert("user_points", {
        user_id:        dosttUserId,
        phone,
        wallet_balance: 0,
        spent_on_audio: 0,
        spent_on_video: 0,
        total_spent:    0,
        ltv:            0,
        updated_at:     new Date(),
      }, ["phone"]).catch(e => logger.warn("user_points zero-row upsert failed", { phone, err: e.message }));
    }
    logger.info("user not found in points table — no spend data", { phone, dosttUserId });
    const excludeCycleStr = userRecord?.cycle_start_date
      ? new Date(userRecord.cycle_start_date).toISOString().split("T")[0]
      : new Date().toISOString().split("T")[0];
    db.insert("points_audit", {
      phone,
      country_code:         countryCode,
      event:                "no_spend_data",
      raw_total_spent:      0,
      baseline_points:      0,
      adjusted_total_spent: 0,
      cycle_start_date:     excludeCycleStr,
      note:                 `dostt_user_id ${dosttUserId} not found in points table (no spend since go-live)`,
    }).catch(e => logger.warn("points_audit no_spend_data insert failed", { phone, err: e.message }));
    return await db.findOne("user_points", { phone });
  }

  // Single-row result for this user
  const r = rows[0];
  const rawTotalSpent = Number(r.total_spent) || 0;

  // Get user's cycle info (resets cycle if expired, passing raw spend as new baseline)
  // Capture return value here — reused for audit log below (avoids a second DB call)
  const cycleStr = await getUserCycleStartDate(phone, countryCode, rawTotalSpent);

  // Re-fetch user after possible cycle reset
  const user = await db.findOne("users", { phone, country_code: countryCode });

  // If baseline was never set (first fetch after login), set it now.
  // NOTE: pg driver returns NUMERIC columns as strings ("0.00"), so use Number() before comparing.
  const isFirstFetchBaseline = user && (user.cycle_baseline_points === null || Number(user.cycle_baseline_points) === 0) && !cached;
  if (isFirstFetchBaseline) {
    await db.update("users", { phone, country_code: countryCode }, {
      cycle_baseline_points: rawTotalSpent,
    });
  }

  // Adjusted = what user earned SINCE joining rewards program (or since last cycle reset)
  // If we just set the baseline above, use rawTotalSpent directly (stale user object still has 0)
  const finalBaseline = isFirstFetchBaseline
    ? rawTotalSpent
    : (user?.cycle_baseline_points != null ? Number(user.cycle_baseline_points) : rawTotalSpent);
  const adjustedTotalSpent = Math.max(0, rawTotalSpent - finalBaseline);

  // Upsert numeric/text fields first. last_refreshed_at_ist is handled
  // separately with a raw cast so the DD/MM/YYYY string from Redash never
  // hits the TIMESTAMPTZ column type check on the primary upsert path.
  await db.upsert("user_points", {
    user_id:        r.user_id              || null,
    phone,
    wallet_balance: Number(r.wallet_balance) || 0,
    spent_on_audio: Number(r.spent_on_audio) || 0,
    spent_on_video: Number(r.spent_on_video) || 0,
    total_spent:    adjustedTotalSpent,
    ltv:            Number(r.ltv)            || 0,
    updated_at:     new Date(),
  }, ["phone"]);

  // Store the raw Redash timestamp string via explicit TEXT cast so it works
  // whether the column is already TEXT or still TIMESTAMPTZ (migration pending).
  if (r.last_refreshed_at_ist) {
    await db.query(
      `UPDATE user_points SET last_refreshed_at_ist = $1::TEXT WHERE phone = $2`,
      [String(r.last_refreshed_at_ist), phone]
    ).catch(() => {}); // silently ignore if column cast still fails
  }

  // Audit log — every points fetch is recorded so complaints can be investigated
  const isFirstFetch = !cached;
  await db.insert("points_audit", {
    phone,
    country_code:         countryCode,
    event:                isFirstFetch ? "first_fetch" : "refresh",
    raw_total_spent:      rawTotalSpent,
    baseline_points:      finalBaseline,
    adjusted_total_spent: adjustedTotalSpent,
    cycle_start_date:     cycleStr,
    note: `raw ${rawTotalSpent} − baseline ${finalBaseline} = ${adjustedTotalSpent}`,
  }).catch(e => logger.warn("points_audit insert failed", { phone, err: e.message }));

  return db.findOne("user_points", { phone });
}

// ── GET /rewards/me ───────────────────────────────────────────────────────────

router.get("/me", async (req, res) => {
  try {
    const { phone, countryCode = "+91" } = req.query;
    if (!phone) return res.status(400).json({ error: "phone is required" });

    // realMode=true lets the test phone bypass the fake MAX_TIER_POINTS override
    // and run the full Redash flow — so testers can verify their real spend.
    const realMode    = req.query.realMode === "true";
    const isTestPhone = TEST_PHONES.includes(phone) && !realMode;

    // Refresh points first — this may reset the cycle, so we must read
    // cycle_start_date AFTER it completes to avoid stale cycleStartDateStr
    const points = await getOrRefreshPoints(phone, countryCode, realMode);

    // Get user's personal cycle dates (post-refresh so cycle reset is reflected)
    const user = await db.findOne("users", { phone, country_code: countryCode });
    const cycleStart = user?.cycle_start_date ? new Date(user.cycle_start_date) : new Date();
    const cycleEnd   = new Date(cycleStart.getTime() + CYCLE_MS);
    const cycleStartDateStr = cycleStart.toISOString().split("T")[0];

    const claimedRows = await db.query(
      `SELECT tier_id FROM claimed_rewards
       WHERE phone = $1 AND country_code = $2 AND cycle_start_date = $3`,
      [phone, countryCode, cycleStartDateStr]
    );

    res.json({
      totalSpent:      isTestPhone ? MAX_TIER_POINTS : (points ? Number(points.total_spent) : 0),
      walletBalance:   points ? Number(points.wallet_balance) : 0,
      spentOnAudio:    points ? Number(points.spent_on_audio) : 0,
      spentOnVideo:    points ? Number(points.spent_on_video) : 0,
      ltv:             points ? Number(points.ltv) : 0,
      lastRefreshedAt: points ? points.last_refreshed_at_ist : null,
      dataUpdatedAt:   points ? points.updated_at : null,
      claimedTiers:    claimedRows.map(r => r.tier_id),
      isTester:        TEST_PHONES.includes(phone), // always true for test phone, even in real mode
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

    // realMode: test phone runs full Redash flow and uses real points for gating
    const realMode       = req.body.realMode === true;
    const isTestPhone    = TEST_PHONES.includes(phone);
    const isDirectSelect = claimMode === "direct_select" && isTestPhone && !realMode;
    const isDummy        = claimType === "dummy" && isTestPhone;

    // Refresh points FIRST — this may reset the cycle if 30 days have passed,
    // so cycle_start_date must be read AFTER this call to avoid stale baseline.
    const points     = await getOrRefreshPoints(phone, countryCode, realMode);
    const totalSpent = (isTestPhone && !realMode) ? MAX_TIER_POINTS : (points ? Number(points.total_spent) : 0);

    // Get user's current cycle start date (post-refresh so any cycle reset is reflected)
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

    // Guard: sequential order — must claim tier N-1 before tier N
    if (tierId > 1 && !isDirectSelect) {
      const prevClaimed = await db.findOne("claimed_rewards", {
        phone,
        country_code:     countryCode,
        tier_id:          tierId - 1,
        cycle_start_date: cycleStartDateStr,
      });
      if (!prevClaimed) {
        return res.status(403).json({ error: `Must claim tier ${tierId - 1} before tier ${tierId}.` });
      }
    }

    // Guard: enough points?
    if (!isDirectSelect && totalSpent < tier.unlockAt) {
      return res.status(403).json({
        error: `Not enough Dostt Points. Need ${tier.unlockAt}, have ${totalSpent}.`,
      });
    }

    // Resolve user_id — read from DB first, fall back to 17538 if missing
    let dosttUserId = null;
    if (!isDummy) {
      const claimUser = await db.findOne("users", { phone, country_code: countryCode });
      dosttUserId = claimUser?.dostt_user_id;
      if (!dosttUserId) {
        // Pre-migration user: dostt_user_id was not saved at login. Look it up now and save.
        logger.warn("dostt_user_id null at claim time — falling back to 17538 lookup", { phone, tierId });
        dosttUserId = await getDosttUserId(phone);
        if (dosttUserId) {
          await db.update("users", { phone, country_code: countryCode }, { dostt_user_id: dosttUserId });
        }
      }
      if (!dosttUserId) {
        logger.error("claim blocked — could not resolve dostt user_id", { phone, tierId });
        return res.status(502).json({
          error: "Account lookup failed. Please log out and back in, then try claiming again.",
        });
      }
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

    // Insert claimed_rewards FIRST — this is the idempotency gate.
    // The unique constraint prevents double-credit even under concurrent requests.
    // Wallet is credited AFTER so a wallet failure can never leave an un-recorded claim.
    let claimed;
    try {
      claimed = await db.insert("claimed_rewards", {
        phone,
        country_code:     countryCode,
        dostt_user_id:    dosttUserId || null,
        tier_id:          tierId,
        unlock_at:        tier.unlockAt,
        coins_awarded:    tier.coins,
        cycle_start_date: cycleStartDateStr,
      });
    } catch (insertErr) {
      // Unique constraint: two concurrent requests raced — treat as already claimed
      if (insertErr.code === "23505") {
        // Close the notification so it doesn't accumulate as a dangling "pending" row
        await db.update("claim_notifications", { id: notification.id }, {
          status:         "duplicate",
          failure_reason: "race condition — tier already claimed this cycle",
        }).catch(() => {});
        return res.status(409).json({ error: "Already claimed this cycle" });
      }
      throw insertErr;
    }

    // Credit wallet — after the claim is recorded
    let walletResponse = null;
    try {
      if (isDummy) {
        logger.info("dummy claim — skipping wallet credit", { phone, tierId });
      } else {
        walletResponse = await creditCoins(dosttUserId, tierId, tier.coins);
      }
      await db.update("claim_notifications", { id: notification.id }, {
        status:          "success",
        wallet_response: walletResponse || null,
      });
    } catch (walletErr) {
      // Wallet failed — roll back the claim record so the user can retry.
      // Track whether the rollback itself succeeded so ops and the user get the right signal.
      let rollbackOk = true;
      await db.query("DELETE FROM claimed_rewards WHERE id = $1", [claimed.id])
        .catch(e => {
          rollbackOk = false;
          // CRITICAL: tier is permanently locked for this user this cycle with no coins credited.
          // Ops must manually DELETE the claimed_rewards row (id: claimed.id) and re-credit coins.
          logger.error("CRITICAL: claimed_rewards rollback failed after wallet error — manual fix needed", {
            phone, tierId, claimedId: claimed.id, claimedCycle: cycleStartDateStr,
            walletErr: walletErr.message, rollbackErr: e.message,
          });
        });

      await db.update("claim_notifications", { id: notification.id }, {
        status:         rollbackOk ? "failed" : "failed_unrolled",
        failure_reason: rollbackOk
          ? walletErr.message
          : `wallet: ${walletErr.message} | ROLLBACK FAILED — claimed_rewards id ${claimed.id} must be deleted manually`,
      }).catch(() => {});

      logger.error("Wallet credit failed", { phone, tierId, rollbackOk, err: walletErr.message });

      const userMsg = rollbackOk
        ? "Failed to credit coins. Please try again."
        : "Something went wrong on our end. Please contact support — do not tap Claim again for this tier.";
      return res.status(502).json({ error: userMsg });
    }

    logger.info("claim success", { phone, tierId, coins: tier.coins, cycle: cycleStartDateStr });
    res.json({ success: true, coinsAwarded: tier.coins, claimed });
  } catch (err) {
    logger.error("rewards /claim error", { err: err.message });
    res.status(500).json({ error: "Failed to claim reward" });
  }
});

module.exports = router;
