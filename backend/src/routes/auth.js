const express = require("express");
const db      = require("../db/client");
const { runQuery } = require("../services/redash");
const logger  = require("../utils/logger");

const router = express.Router();

// ⚠️ Also defined in: app.js (line ~71) and routes/rewards.js (line ~10) — keep all three in sync
const TEST_PHONES = ["9988818731"];

async function lookupDosttUser(phone) {
  const queryId = Number(process.env.REDASH_VERIFY_PHONE_QUERY_ID);
  if (!queryId) return null;
  try {
    // Query uses {{ mobile_numbers }} parameter.
    // max_age: 3600 — use Redash cache if < 1h old. Avoids a live BigQuery
    // run on every login (which caused 10-15s delays). New Dostt signups may
    // wait up to 1h before they can log in here — acceptable tradeoff.
    const rows = await runQuery(queryId, { mobile_numbers: phone }, 3600);
    if (!rows.length) return null;
    // Defensively confirm the returned row actually matches this phone.
    // Redash strips the +91 country prefix, so normalise before comparing.
    const normalised = phone.replace(/^(\+?91)/, "");
    const match = rows.find(r => {
      const rowPhone = String(r.mobile_no || "").replace(/^(\+?91)/, "");
      return rowPhone === normalised;
    });
    // Also require user_id to be present — a row with null user_id means
    // the Redash join failed for this phone. Without user_id we can't fetch
    // points or credit coins, so treat it the same as "not found".
    if (!match || !match.user_id) return null;
    return match;
  } catch (err) {
    throw Object.assign(new Error("Redash lookup failed"), { isRedashError: true, cause: err });
  }
}

async function recordLogin(phone, countryCode, dosttUserId, status, errorReason = null) {
  try {
    await db.insert("login_logs", {
      phone,
      country_code:   countryCode,
      dostt_user_id:  dosttUserId || null,
      status,
      error_reason:   errorReason,
    });
  } catch (err) {
    logger.warn("Failed to write login log", { phone, err: err.message });
  }
}

// POST /auth/login
// body: { phone, countryCode }
// Flow: validate phone → check Redash → if registered, create/update user → return session
router.post("/login", async (req, res) => {
  const { phone, countryCode = "+91" } = req.body;

  try {
    if (!phone || !/^\d{7,15}$/.test(phone)) {
      await recordLogin(phone || "", countryCode, null, "failed", "Invalid phone number");
      return res.status(400).json({ error: "Invalid phone number" });
    }

    const isTester = TEST_PHONES.includes(phone);
    let dosttUser = null;

    if (!isTester) {
      // Verify phone is a registered Dostt user via Redash
      if (!process.env.REDASH_VERIFY_PHONE_QUERY_ID) {
        // Env var missing — block the login rather than silently letting everyone in
        logger.error("REDASH_VERIFY_PHONE_QUERY_ID not configured — login blocked", { phone });
        await recordLogin(phone, countryCode, null, "failed", "REDASH_VERIFY_PHONE_QUERY_ID not set");
        return res.status(503).json({ error: "Verification service unavailable. Please try again." });
      } else {
        try {
          dosttUser = await lookupDosttUser(phone);
        } catch (err) {
          await recordLogin(phone, countryCode, null, "failed", "Redash lookup failed");
          logger.error("Redash verify error", { phone, err: err.message });
          return res.status(503).json({ error: "Verification service unavailable. Please try again." });
        }

        if (!dosttUser) {
          await recordLogin(phone, countryCode, null, "failed", "User not registered on Dostt");
          return res.status(403).json({ error: "Please use your Dostt registered number" });
        }
      }
    }

    const dosttUserId = dosttUser?.user_id || null;

    if (dosttUserId) {
      // If auto-login created a null-phone placeholder for this dostt_user_id,
      // that row is the real one (has correct cycle_start_date/baseline).
      // Fill in the phone there and drop any stale phone-only duplicate.
      const placeholderRows = await db.query(
        "SELECT id FROM users WHERE dostt_user_id = $1 AND phone IS NULL LIMIT 1",
        [String(dosttUserId)]
      );
      if (placeholderRows.length) {
        // Remove any phone-only row that may have been created by a concurrent upsert
        await db.query(
          "DELETE FROM users WHERE phone = $1 AND country_code = $2 AND dostt_user_id IS NULL",
          [phone, countryCode]
        );
        // Fill phone into the real auto-login row (preserves cycle data)
        await db.query(
          "UPDATE users SET phone = $1 WHERE dostt_user_id = $2 AND phone IS NULL",
          [phone, String(dosttUserId)]
        );
        await recordLogin(phone, countryCode, dosttUserId, "success");
        logger.info("login success (placeholder merged)", { phone, isTester, dosttUserId });
        return res.json({ success: true, user: { phone, countryCode }, isTester });
      }
    }

    // No auto-login placeholder — standard upsert by phone
    await db.upsert(
      "users",
      { phone, country_code: countryCode },
      ["phone", "country_code"]
    );

    const existingUser = await db.findOne("users", { phone, country_code: countryCode });
    const updates = {};
    if (!existingUser?.cycle_start_date) {
      updates.cycle_start_date      = new Date();
      updates.cycle_baseline_points = -1;
    }
    if (dosttUserId) {
      updates.dostt_user_id = dosttUserId;
    }
    if (Object.keys(updates).length) {
      await db.update("users", { phone, country_code: countryCode }, updates);
    }

    await recordLogin(phone, countryCode, dosttUserId, "success");

    logger.info("login success", { phone, isTester, dosttUserId });
    res.json({ success: true, user: { phone, countryCode }, isTester });
  } catch (err) {
    logger.error("login error", { phone, err: err.message });
    await recordLogin(phone || "", countryCode, null, "failed", err.message);
    res.status(500).json({ error: "Login failed" });
  }
});

// POST /auth/login-by-userid
// body: { dosttUserId }
// Auto-login path used when the Dostt app banner passes ?user_id=<base64> in the URL.
// dostt_user_id is the primary identifier — phone is resolved opportunistically and
// stored when available. If phone is not yet in cache the user is still logged in
// with 0 points; the 30-min points_raw_cache sync backfills phone automatically.
// Resolution order: users table (returning) → points_raw_cache (banner cohort)
router.post("/login-by-userid", async (req, res) => {
  const { dosttUserId } = req.body;
  const countryCode = "+91";

  if (!dosttUserId || isNaN(Number(dosttUserId))) {
    return res.status(400).json({ error: "Invalid user ID" });
  }

  const userIdStr = String(dosttUserId);

  try {
    let phone         = null;
    let rawTotalSpent = null;

    // 1. Returning user — phone already stored in our DB
    const existingRows = await db.query(
      "SELECT phone FROM users WHERE dostt_user_id = $1 LIMIT 1",
      [userIdStr]
    );
    if (existingRows.length) phone = existingRows[0].phone || null;

    // 2. Banner cohort — points_raw_cache has mobile_no (synced every 30 min)
    if (!phone) {
      const cacheRows = await db.query(
        "SELECT mobile_no, raw_total_spent FROM points_raw_cache WHERE dostt_user_id = $1 LIMIT 1",
        [userIdStr]
      );
      if (cacheRows.length && cacheRows[0].mobile_no) {
        phone         = String(cacheRows[0].mobile_no).replace(/^(\+?91)/, "");
        rawTotalSpent = Number(cacheRows[0].raw_total_spent) || 0;
      }
    }

    if (phone) {
      // Phone resolved — full upsert with cycle setup
      await db.upsert("users", { phone, country_code: countryCode }, ["phone", "country_code"]);
      const userRecord = await db.findOne("users", { phone, country_code: countryCode });
      const updates = { dostt_user_id: userIdStr };
      if (!userRecord?.cycle_start_date) {
        updates.cycle_start_date      = new Date();
        updates.cycle_baseline_points = rawTotalSpent !== null ? rawTotalSpent : -1;
      }
      await db.update("users", { phone, country_code: countryCode }, updates);
    } else {
      // Phone not yet in cache — create a user record keyed by dostt_user_id only.
      // The 30-min sync will backfill phone from points_raw_cache.mobile_no.
      await db.query(
        `INSERT INTO users (dostt_user_id, country_code, cycle_start_date, cycle_baseline_points)
         VALUES ($1, $2, NOW(), 0)
         ON CONFLICT (dostt_user_id) WHERE dostt_user_id IS NOT NULL DO NOTHING`,
        [userIdStr, countryCode]
      );
    }

    await recordLogin(phone || "", countryCode, userIdStr, "success");
    logger.info("auto-login success", { phone, dosttUserId: userIdStr });

    res.json({
      success: true,
      user: { phone: phone || null, dosttUserId: userIdStr, countryCode },
      isTester: phone ? TEST_PHONES.includes(phone) : false,
    });
  } catch (err) {
    logger.error("login-by-userid error", { dosttUserId: userIdStr, err: err.message });
    await recordLogin("", countryCode, userIdStr, "failed", err.message);
    res.status(500).json({ error: "Auto-login failed" });
  }
});

// GET /auth/verify?phone=&countryCode=
// Lightweight session re-validation — same Redash check as /login but
// writes NO login_log entry and does NOT modify the users table.
// Used by the frontend on session restore so re-opens don't spam login_logs.
router.get("/verify", async (req, res) => {
  const { phone, countryCode = "+91" } = req.query;

  if (!phone || !/^\d{7,15}$/.test(phone)) {
    return res.status(400).json({ error: "Invalid phone number" });
  }

  if (TEST_PHONES.includes(phone)) {
    return res.json({ valid: true });
  }

  if (!process.env.REDASH_VERIFY_PHONE_QUERY_ID) {
    return res.status(503).json({ error: "Verification service unavailable." });
  }

  try {
    const dosttUser = await lookupDosttUser(phone);
    if (!dosttUser) {
      return res.status(403).json({ error: "Please use your Dostt registered number" });
    }
    res.json({ valid: true });
  } catch (err) {
    // Redash down — don't kick the user out, just let them through
    logger.warn("verify Redash error — allowing session", { phone, err: err.message });
    res.json({ valid: true, degraded: true });
  }
});

module.exports = router;
