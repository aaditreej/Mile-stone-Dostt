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
          logger.warn("Redash verify error, trying points_raw_cache fallback", { phone, err: err.message });
          try {
            const normalised = phone.replace(/^(\+?91)/, "");
            const cacheRows = await db.query(
              `SELECT dostt_user_id FROM points_raw_cache WHERE mobile_no = $1 OR mobile_no = $2 OR mobile_no = $3 LIMIT 1`,
              [phone, normalised, `91${normalised}`]
            );
            if (cacheRows.length) {
              dosttUser = { user_id: cacheRows[0].dostt_user_id, mobile_no: phone };
              logger.info("login verified via points_raw_cache fallback", { phone });
            }
          } catch (cacheErr) {
            logger.warn("points_raw_cache login fallback failed", { phone, err: cacheErr.message });
          }
          if (!dosttUser) {
            await recordLogin(phone, countryCode, null, "failed", "Redash lookup failed");
            logger.error("Redash verify error", { phone, err: err.message });
            return res.status(503).json({ error: "Verification service unavailable. Please try again." });
          }
        }

        if (!dosttUser) {
          await recordLogin(phone, countryCode, null, "failed", "User not registered on Dostt");
          return res.status(403).json({ error: "Please use your Dostt registered number" });
        }
      }
    }

    const dosttUserId = dosttUser?.user_id || null;

    // Upsert user record
    await db.upsert(
      "users",
      { phone, country_code: countryCode },
      ["phone", "country_code"]
    );

    // Set cycle_start_date on first login only (never overwrite existing)
    // Always persist dostt_user_id so rewards.js can use it without a Redash call
    const existingUser = await db.findOne("users", { phone, country_code: countryCode });
    const updates = {};
    if (!existingUser?.cycle_start_date) {
      updates.cycle_start_date      = new Date();
      // Sentinel -1 = "baseline not yet confirmed by a live Redash fetch".
      // getOrRefreshPoints sets it to rawTotalSpent on the first successful fetch,
      // regardless of whether a cached user_points row already exists (avoids the
      // stale-BQ-at-first-fetch bug where pre-login spend would be counted).
      updates.cycle_baseline_points = -1;
    }
    if (dosttUserId) updates.dostt_user_id = dosttUserId;
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
