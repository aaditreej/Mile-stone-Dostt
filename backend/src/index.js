require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const logger  = require("./utils/logger");
const { migrate } = require("../scripts/migrate");

const authRoutes    = require("./routes/auth");
const rewardsRoutes = require("./routes/rewards");
const adminRoutes   = require("./routes/admin");

const app  = express();
const PORT = process.env.PORT || 3001;

// Repo root is two levels up from backend/src/
const FRONTEND_DIR = path.join(__dirname, "../../");

app.use(cors());
app.use(express.json());

// ── Health probes ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ── API routes (frontend calls /api/* in production) ──────────────────────────
app.use("/api/auth",    authRoutes);
app.use("/api/rewards", rewardsRoutes);
app.use("/api/admin",   adminRoutes);

// ── Frontend static files ──────────────────────────────────────────────────────
app.use(express.static(FRONTEND_DIR));

// SPA fallback — serve index.html for any non-API route
app.get("*", (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

// ── Periodic audit-table cleanup ──────────────────────────────────────────────
// With max_age:0, every /rewards/me writes a points_audit row. Run a prune
// daily so the table stays small between pod restarts.
// Migration already prunes on startup; this covers long-running pods.
function scheduleAuditCleanup(db) {
  const INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
  async function prune() {
    try {
      const r = await db.query(
        `DELETE FROM points_audit WHERE created_at < NOW() - INTERVAL '90 days'`
      );
      if (r.length > 0) {
        logger.info("points_audit pruned", { deleted: r.length });
      }
    } catch (err) {
      logger.warn("points_audit prune failed", { err: err.message });
    }
  }
  setInterval(prune, INTERVAL_MS);
}

// ── Bulk points cache sync (every 30 min, query 18796) ────────────────────────
// Pulls all banner-funnel users from BQ via a single non-parameterized Redash
// query and bulk-upserts raw spend data into points_raw_cache. If Redash fails
// on a live /rewards/me request, the backend falls back to this table.
function scheduleRawCacheSync(db) {
  const redash     = require("./services/redash");
  const queryId    = Number(process.env.REDASH_ALL_USERS_QUERY_ID);
  const INTERVAL_MS = 30 * 60 * 1000;

  async function sync() {
    if (!queryId) return;
    try {
      const rows = await redash.runQuery(queryId, {}, 0);
      if (!rows || !rows.length) {
        logger.warn("points_raw_cache sync: no rows returned");
        return;
      }
      // Bulk upsert — one query per row (rows expected to be in hundreds, not millions)
      for (const r of rows) {
        if (!r.user_id) continue;
        await db.query(
          `INSERT INTO points_raw_cache
             (dostt_user_id, mobile_no, wallet_balance, spent_on_audio,
              spent_on_video, raw_total_spent, last_refreshed_at_ist, ltv, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
           ON CONFLICT (dostt_user_id) DO UPDATE SET
             mobile_no             = EXCLUDED.mobile_no,
             wallet_balance        = EXCLUDED.wallet_balance,
             spent_on_audio        = EXCLUDED.spent_on_audio,
             spent_on_video        = EXCLUDED.spent_on_video,
             raw_total_spent       = EXCLUDED.raw_total_spent,
             last_refreshed_at_ist = EXCLUDED.last_refreshed_at_ist,
             ltv                   = EXCLUDED.ltv,
             synced_at             = NOW()`,
          [
            String(r.user_id),
            r.mobile_no   || null,
            Number(r.wallet_balance)  || 0,
            Number(r.spent_on_audio)  || 0,
            Number(r.spent_on_video)  || 0,
            Number(r.total_spent)     || 0,
            r.last_refreshed_at_ist   || null,
            Number(r.ltv)             || 0,
          ]
        );
      }
      // Backfill phone for users who auto-logged in before their phone was cached
      await db.query(`
        UPDATE users u
        SET phone = REGEXP_REPLACE(prc.mobile_no, '^(\\+?91)', '')
        FROM points_raw_cache prc
        WHERE u.dostt_user_id = prc.dostt_user_id
          AND u.phone IS NULL
          AND prc.mobile_no IS NOT NULL
      `).catch(e => logger.warn("phone backfill failed", { err: e.message }));

      logger.info("points_raw_cache synced", { count: rows.length });
    } catch (err) {
      logger.warn("points_raw_cache sync failed", { err: err.message });
    }
  }

  sync(); // run immediately on startup
  setInterval(sync, INTERVAL_MS);
}

// ── Run migrations then start ──────────────────────────────────────────────────
migrate()
  .then(() => {
    const db = require("./db/client");
    scheduleAuditCleanup(db);
    scheduleRawCacheSync(db);
    app.listen(PORT, () => {
      logger.info("server started", {
        port: PORT,
        dbAdapter: process.env.DB_ADAPTER || "postgres",
      });
    });
  })
  .catch(err => {
    logger.error("Migration failed — server not started", { err: err.message });
    process.exit(1);
  });
