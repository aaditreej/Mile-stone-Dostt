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

// ── Run migrations then start ──────────────────────────────────────────────────
migrate()
  .then(() => {
    const db = require("./db/client");
    scheduleAuditCleanup(db);
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
