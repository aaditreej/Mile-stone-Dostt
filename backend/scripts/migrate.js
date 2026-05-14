/**
 * Run with:  npm run migrate
 * Safe to re-run — uses IF NOT EXISTS throughout.
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const db = require("../src/db/client");

const tables = [
  {
    name: "users",
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id           SERIAL PRIMARY KEY,
        phone        VARCHAR(20) NOT NULL,
        country_code VARCHAR(10) NOT NULL DEFAULT '+91',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (phone, country_code)
      );
    `,
  },
  {
    name: "user_points",
    sql: `
      CREATE TABLE IF NOT EXISTS user_points (
        id                    SERIAL PRIMARY KEY,
        user_id               VARCHAR(100),
        phone             VARCHAR(20)   NOT NULL UNIQUE,
        wallet_balance        NUMERIC(14,2) NOT NULL DEFAULT 0,
        spent_on_audio        NUMERIC(14,2) NOT NULL DEFAULT 0,
        spent_on_video        NUMERIC(14,2) NOT NULL DEFAULT 0,
        total_spent           NUMERIC(14,2) NOT NULL DEFAULT 0,
        last_refreshed_at_ist TIMESTAMPTZ,
        ltv                   NUMERIC(14,2) NOT NULL DEFAULT 0,
        updated_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `,
  },
  {
    name: "user_points rename columns (safe)",
    sql: `
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_points' AND column_name='mobile_no') THEN
          ALTER TABLE user_points RENAME COLUMN mobile_no TO phone;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='user_points' AND column_name='synced_at') THEN
          ALTER TABLE user_points RENAME COLUMN synced_at TO updated_at;
        END IF;
      END $$;
    `,
  },
  {
    name: "login_logs",
    sql: `
      CREATE TABLE IF NOT EXISTS login_logs (
        id            SERIAL PRIMARY KEY,
        phone         VARCHAR(20) NOT NULL,
        country_code  VARCHAR(10) NOT NULL DEFAULT '+91',
        dostt_user_id VARCHAR(100),
        status        VARCHAR(10) NOT NULL,
        error_reason  TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_login_phone  ON login_logs (phone);
      CREATE INDEX IF NOT EXISTS idx_login_status ON login_logs (status);
    `,
  },
  {
    name: "claimed_rewards",
    sql: `
      CREATE TABLE IF NOT EXISTS claimed_rewards (
        id            SERIAL PRIMARY KEY,
        phone         VARCHAR(20)  NOT NULL,
        country_code  VARCHAR(10)  NOT NULL DEFAULT '+91',
        dostt_user_id VARCHAR(100),
        tier_id       INTEGER      NOT NULL,
        unlock_at     INTEGER      NOT NULL DEFAULT 0,
        coins_awarded INTEGER      NOT NULL DEFAULT 0,
        cycle_number  INTEGER      NOT NULL DEFAULT 1,
        claimed_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        UNIQUE (phone, country_code, tier_id, cycle_number)
      );
      CREATE INDEX IF NOT EXISTS idx_claimed_phone ON claimed_rewards (phone, country_code);
      CREATE INDEX IF NOT EXISTS idx_claimed_cycle ON claimed_rewards (cycle_number);
    `,
  },
  {
    name: "claim_notifications",
    sql: `
      CREATE TABLE IF NOT EXISTS claim_notifications (
        id             SERIAL PRIMARY KEY,
        phone          VARCHAR(20)  NOT NULL,
        country_code   VARCHAR(10)  NOT NULL DEFAULT '+91',
        dostt_user_id  VARCHAR(100),
        tier_id        INTEGER      NOT NULL,
        tier_unlock_at INTEGER,
        coins_awarded  INTEGER,
        cycle_number   INTEGER      NOT NULL,
        claim_mode     VARCHAR(20),
        claim_type     VARCHAR(20),
        status         VARCHAR(20)  NOT NULL DEFAULT 'pending',
        failure_reason TEXT,
        wallet_response JSONB,
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_notif_phone  ON claim_notifications (phone);
      CREATE INDEX IF NOT EXISTS idx_notif_status ON claim_notifications (status);
    `,
  },

  // ── Views ────────────────────────────────────────────────────────────────────

  {
    name: "drop old views (safe)",
    sql: `
      DROP VIEW IF EXISTS v_eligible_not_claimed CASCADE;
      DROP VIEW IF EXISTS v_user_performance CASCADE;
      DROP VIEW IF EXISTS v_claim_logs CASCADE;
      DROP VIEW IF EXISTS v_login_logs CASCADE;
      DROP VIEW IF EXISTS v_waiting_for_cooldown CASCADE;
    `,
  },
  {
    name: "view: v_login_logs",
    sql: `
      CREATE OR REPLACE VIEW v_login_logs AS
      SELECT phone, country_code, dostt_user_id, status, error_reason, created_at
      FROM login_logs
      ORDER BY created_at DESC;
    `,
  },
  {
    name: "view: v_claim_logs",
    sql: `
      CREATE OR REPLACE VIEW v_claim_logs AS
      SELECT
        cn.phone,
        cn.country_code,
        cn.dostt_user_id,
        cn.tier_id,
        cn.tier_unlock_at,
        cn.coins_awarded,
        cn.claim_mode,
        cn.claim_type,
        cn.status,
        cn.failure_reason,
        cn.created_at
      FROM claim_notifications cn
      ORDER BY cn.created_at DESC;
    `,
  },
  {
    name: "view: v_user_performance",
    sql: `
      CREATE OR REPLACE VIEW v_user_performance AS
      SELECT
        u.phone,
        u.country_code,
        up.total_spent,
        up.wallet_balance,
        up.last_refreshed_at_ist,
        COUNT(DISTINCT ll.id) FILTER (WHERE ll.status = 'success')  AS total_logins,
        MAX(ll.created_at)    FILTER (WHERE ll.status = 'success')  AS last_login_at,
        COUNT(DISTINCT cr.id)                                        AS tiers_claimed,
        COALESCE(SUM(cr.coins_awarded), 0)                          AS total_coins_earned,
        MAX(cr.claimed_at)                                           AS last_claimed_at
      FROM users u
      LEFT JOIN user_points       up ON up.phone  = u.phone
      LEFT JOIN login_logs        ll ON ll.phone       = u.phone
      LEFT JOIN claimed_rewards   cr ON cr.phone       = u.phone
      GROUP BY u.phone, u.country_code, up.total_spent, up.wallet_balance, up.last_refreshed_at_ist;
    `,
  },
  {
    name: "view: v_eligible_not_claimed",
    sql: `
      CREATE OR REPLACE VIEW v_eligible_not_claimed AS
      -- Users who have unlocked a tier but haven't claimed it yet this cycle
      SELECT
        up.phone  AS phone,
        up.total_spent,
        t.tier_id,
        t.unlock_at,
        t.coins
      FROM user_points up
      CROSS JOIN (
        VALUES
          (1,200,20),(2,400,20),(3,700,20),(4,1000,30),(5,1400,30),
          (6,1900,30),(7,2500,40),(8,3200,40),(9,4000,50),(10,4900,50),
          (11,6100,60),(12,7600,60),(13,9600,70),(14,12100,70),
          (15,15350,80),(16,19350,80),(17,24350,90)
      ) AS t(tier_id, unlock_at, coins)
      WHERE up.total_spent >= t.unlock_at
        AND NOT EXISTS (
          SELECT 1 FROM claimed_rewards cr
          WHERE cr.phone = up.phone
            AND cr.tier_id = t.tier_id
        )
      ORDER BY up.total_spent DESC, t.tier_id;
    `,
  },
];

async function migrate() {
  console.log("Running migrations…\n");
  for (const table of tables) {
    try {
      await db.query(table.sql);
      console.log(`  ✓  ${table.name}`);
    } catch (err) {
      console.error(`  ✗  ${table.name}: ${err.message}`);
      process.exit(1);
    }
  }
  console.log("\nAll tables ready.");
  process.exit(0);
}

migrate();
