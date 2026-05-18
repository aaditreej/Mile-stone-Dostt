require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const logger  = require("./utils/logger");

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

app.listen(PORT, () => {
  logger.info("server started", {
    port: PORT,
    dbAdapter: process.env.DB_ADAPTER || "postgres",
  });
});
