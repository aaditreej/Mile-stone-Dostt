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

// GET /admin/reports/claim-logs?phone=&status=&claim_type=&claim_mode=&limit=100
router.get("/reports/claim-logs", async (req, res) => {
  try {
    const { phone, status, claim_type, claim_mode, limit = "100" } = req.query;
    const conditions = [];
    const values = [];
    if (phone)      { conditions.push(`phone = $${values.length + 1}`);      values.push(phone); }
    if (status)     { conditions.push(`status = $${values.length + 1}`);     values.push(status); }
    if (claim_type) { conditions.push(`claim_type = $${values.length + 1}`); values.push(claim_type); }
    if (claim_mode) { conditions.push(`claim_mode = $${values.length + 1}`); values.push(claim_mode); }
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
      rows = await db.query("SELECT * FROM v_user_performance ORDER BY total_coins_claimed DESC LIMIT 500");
    }
    res.json({ count: rows.length, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
