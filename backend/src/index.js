require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const logger  = require("./utils/logger");

const authRoutes    = require("./routes/auth");
const rewardsRoutes = require("./routes/rewards");
const adminRoutes   = require("./routes/admin");

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/",       (_req, res) => res.json({ status: "ok" })); // k8s probe fallback
app.use("/auth",    authRoutes);
app.use("/rewards", rewardsRoutes);
app.use("/admin",   adminRoutes);

app.listen(PORT, () => {
  logger.info("server started", {
    port: PORT,
    dbAdapter: process.env.DB_ADAPTER || "postgres",
  });
  logger.info("points fetched per-user from Redash");
});
