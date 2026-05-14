const express = require("express");
const db      = require("../db/client");
const { runQuery } = require("../services/redash");
const logger  = require("../utils/logger");

const router = express.Router();

const TEST_PHONES = ["9500365660", "9988818731"];

async function lookupDosttUser(phone) {
  const queryId = Number(process.env.REDASH_VERIFY_PHONE_QUERY_ID);
  if (!queryId) return null;
  try {
    // Query uses {{ mobile_numbers }} parameter
    const rows = await runQuery(queryId, { mobile_numbers: phone }, 0);
    return rows.length ? rows[0] : null;
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
        // No query configured — allow all numbers (dev mode)
        logger.warn("REDASH_VERIFY_PHONE_QUERY_ID not set, skipping verification", { phone });
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

    // Upsert user record
    await db.upsert(
      "users",
      { phone, country_code: countryCode },
      ["phone", "country_code"]
    );

    await recordLogin(phone, countryCode, dosttUserId, "success");

    logger.info("login success", { phone, isTester, dosttUserId });
    res.json({ success: true, user: { phone, countryCode }, isTester });
  } catch (err) {
    logger.error("login error", { phone, err: err.message });
    await recordLogin(phone || "", countryCode, null, "failed", err.message);
    res.status(500).json({ error: "Login failed" });
  }
});

module.exports = router;
