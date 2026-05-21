const express = require("express");
const db = require("../db/client");

const router = express.Router();

function requireAdminKey(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

router.use(requireAdminKey);

// GET /admin/reports/eligible-not-claimed
// Users with an unlocked tier, no active cooldown, but haven't claimed
router.get("/reports/eligible-not-claimed", async (req, res) => {
  try {
    const rows = await db.query("SELECT * FROM v_eligible_not_claimed ORDER BY total_spent DESC");
    res.json({ count: rows.length, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/reports/login-logs?phone=&status=&limit=100
router.get("/reports/login-logs", async (req, res) => {
  try {
    const { phone, status, limit = "100" } = req.query;
    const conditions = [];
    const values = [];
    if (phone)  { conditions.push(`phone = $${values.length + 1}`);  values.push(phone); }
    if (status) { conditions.push(`status = $${values.length + 1}`); values.push(status); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await db.query(
      `SELECT * FROM v_login_logs ${where} LIMIT $${values.length + 1}`,
      [...values, Math.min(Number(limit), 1000)]
    );
    res.json({ count: rows.length, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/reports/claim-logs?phone=&status=&tier_id=&limit=100
// Note: claim_type and claim_mode were removed from v_claim_logs — do not filter by them
router.get("/reports/claim-logs", async (req, res) => {
  try {
    const { phone, status, tier_id, limit = "100" } = req.query;
    const conditions = [];
    const values = [];
    if (phone)   { conditions.push(`phone = $${values.length + 1}`);   values.push(phone); }
    if (status)  { conditions.push(`status = $${values.length + 1}`);  values.push(status); }
    if (tier_id) { conditions.push(`tier_id = $${values.length + 1}`); values.push(Number(tier_id)); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await db.query(
      `SELECT * FROM v_claim_logs ${where} LIMIT $${values.length + 1}`,
      [...values, Math.min(Number(limit), 1000)]
    );
    res.json({ count: rows.length, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/reports/user-performance?phone=
router.get("/reports/user-performance", async (req, res) => {
  try {
    const { phone } = req.query;
    let rows;
    if (phone) {
      rows = await db.query("SELECT * FROM v_user_performance WHERE phone = $1", [phone]);
    } else {
      rows = await db.query("SELECT * FROM v_user_performance ORDER BY total_coins_earned DESC LIMIT 500");
    }
    res.json({ count: rows.length, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
