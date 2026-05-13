/**
 * Run with:  npm run migrate
 *
 * Creates all tables if they don't exist yet.
 * Safe to re-run — uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS throughout.
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const db = require("../src/db/client");

const tables = [
  {
    name: "users",
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id           SERIAL PRIMARY KEY,
        phone        VARCHAR(20)  NOT NULL,
        country_code VARCHAR(10)  NOT NULL DEFAULT '+91',
        next_claim_at TIMESTAMPTZ,
        created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        UNIQUE (phone, country_code)
      );
    `,
  },
  {
    name: "users cooldown column (safe)",
    sql: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS next_claim_at TIMESTAMPTZ;
    `,
  },
  {
    name: "user_points",
    sql: `
      CREATE TABLE IF NOT EXISTS user_points (
        id                    SERIAL PRIMARY KEY,
        user_id               VARCHAR(100),
        mobile_no             VARCHAR(20)   NOT NULL,
        wallet_balance        NUMERIC(14,2) NOT NULL DEFAULT 0,
        spent_on_audio        NUMERIC(14,2) NOT NULL DEFAULT 0,
        spent_on_video        NUMERIC(14,2) NOT NULL DEFAULT 0,
        total_spent           NUMERIC(14,2) NOT NULL DEFAULT 0,
        last_refreshed_at_ist TIMESTAMPTZ,
        ltv                   NUMERIC(14,2) NOT NULL DEFAULT 0,
        synced_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        UNIQUE (mobile_no)
      );
    `,
  },
  {
    name: "claimed_rewards",
    sql: `
      CREATE TABLE IF NOT EXISTS claimed_rewards (
        id             SERIAL PRIMARY KEY,
        phone          VARCHAR(20)   NOT NULL,
        country_code   VARCHAR(10)   NOT NULL,
        dostt_user_id  VARCHAR(100),
        tier_id        INTEGER       NOT NULL,
        unlock_at      INTEGER       NOT NULL DEFAULT 0,
        coins_awarded  INTEGER       NOT NULL DEFAULT 0,
        cycle_number   INTEGER       NOT NULL DEFAULT 1,
        claimed_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        UNIQUE (phone, country_code, tier_id, cycle_number)
      );
      CREATE INDEX IF NOT EXISTS idx_claimed_phone  ON claimed_rewards (phone, country_code);
      CREATE INDEX IF NOT EXISTS idx_claimed_tier   ON claimed_rewards (tier_id);
      CREATE INDEX IF NOT EXISTS idx_claimed_cycle  ON claimed_rewards (cycle_number);
    `,
  },
  {
    name: "claimed_rewards backfill columns (safe)",
    sql: `
      ALTER TABLE claimed_rewards ADD COLUMN IF NOT EXISTS cycle_number  INTEGER      NOT NULL DEFAULT 1;
      ALTER TABLE claimed_rewards ADD COLUMN IF NOT EXISTS dostt_user_id VARCHAR(100);
      ALTER TABLE claimed_rewards ADD COLUMN IF NOT EXISTS unlock_at     INTEGER      NOT NULL DEFAULT 0;
      ALTER TABLE claimed_rewards ADD COLUMN IF NOT EXISTS coins_awarded INTEGER      NOT NULL DEFAULT 0;
    `,
  },
  {
    name: "login_logs",
    sql: `
      CREATE TABLE IF NOT EXISTS login_logs (
        id             SERIAL PRIMARY KEY,
        phone          VARCHAR(20)  NOT NULL,
        country_code   VARCHAR(10)  NOT NULL DEFAULT '+91',
        dostt_user_id  VARCHAR(100),
        status         VARCHAR(10)  NOT NULL,
        error_reason   TEXT,
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_login_logs_phone  ON login_logs (phone);
      CREATE INDEX IF NOT EXISTS idx_login_logs_status ON login_logs (status);
    `,
  },
  {
    name: "login_logs new columns (safe)",
    sql: `
      ALTER TABLE login_logs ADD COLUMN IF NOT EXISTS dostt_user_id VARCHAR(100);
    `,
  },
  {
    name: "claim_notifications",
    sql: `
      CREATE TABLE IF NOT EXISTS claim_notifications (
        id              SERIAL PRIMARY KEY,
        phone           VARCHAR(20)   NOT NULL,
        country_code    VARCHAR(10)   NOT NULL,
        tier_id         INTEGER       NOT NULL,
        tier_unlock_at  INTEGER,
        tier_coins      INTEGER,
        cycle_number    INTEGER       NOT NULL,
        coins_awarded   INTEGER,
        claim_mode      VARCHAR(20),
        claim_type      VARCHAR(20),
        dostt_user_id   VARCHAR(100),
        status          VARCHAR(20)   NOT NULL DEFAULT 'pending',
        failure_reason  TEXT,
        redash_response JSONB,
        created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_notif_phone  ON claim_notifications (phone, country_code);
      CREATE INDEX IF NOT EXISTS idx_notif_status ON claim_notifications (status);
    `,
  },
  {
    name: "claim_notifications new columns (safe)",
    sql: `
      ALTER TABLE claim_notifications ADD COLUMN IF NOT EXISTS claim_mode    VARCHAR(20);
      ALTER TABLE claim_notifications ADD COLUMN IF NOT EXISTS claim_type    VARCHAR(20);
      ALTER TABLE claim_notifications ADD COLUMN IF NOT EXISTS dostt_user_id VARCHAR(100);
      ALTER TABLE claim_notifications ADD COLUMN IF NOT EXISTS tier_unlock_at INTEGER;
      ALTER TABLE claim_notifications ADD COLUMN IF NOT EXISTS tier_coins     INTEGER;
    `,
  },
  {
    name: "claims_pending",
    sql: `
      CREATE TABLE IF NOT EXISTS claims_pending (
        id                  SERIAL PRIMARY KEY,
        user_id             VARCHAR(100),
        phone               VARCHAR(20)  NOT NULL,
        country_code        VARCHAR(10)  NOT NULL DEFAULT '+91',
        tier_id             INTEGER      NOT NULL,
        tier_unlock_at      INTEGER      NOT NULL,
        coins               INTEGER      NOT NULL,
        cycle_number        INTEGER      NOT NULL DEFAULT 1,
        became_claimable_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        UNIQUE (phone, country_code, tier_id, cycle_number)
      );
      CREATE INDEX IF NOT EXISTS idx_pending_phone  ON claims_pending (phone, country_code);
      CREATE INDEX IF NOT EXISTS idx_pending_cycle  ON claims_pending (cycle_number);
    `,
  },
  {
    name: "claims_claimed",
    sql: `
      CREATE TABLE IF NOT EXISTS claims_claimed (
        id                  SERIAL PRIMARY KEY,
        user_id             VARCHAR(100),
        phone               VARCHAR(20)  NOT NULL,
        country_code        VARCHAR(10)  NOT NULL DEFAULT '+91',
        tier_id             INTEGER      NOT NULL,
        tier_unlock_at      INTEGER      NOT NULL,
        coins               INTEGER      NOT NULL,
        cycle_number        INTEGER      NOT NULL DEFAULT 1,
        became_claimable_at TIMESTAMPTZ,
        claimed_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        UNIQUE (phone, country_code, tier_id, cycle_number)
      );
      CREATE INDEX IF NOT EXISTS idx_claimed2_phone ON claims_claimed (phone, country_code);
      CREATE INDEX IF NOT EXISTS idx_claimed2_cycle ON claims_claimed (cycle_number);
    `,
  },
  {
    name: "view: v_eligible_not_claimed",
    sql: `
      CREATE OR REPLACE VIEW v_eligible_not_claimed AS
      SELECT DISTINCT
        cp.phone,
        cp.country_code,
        cp.user_id,
        cp.tier_id,
        cp.tier_unlock_at,
        cp.coins,
        cp.cycle_number,
        cp.became_claimable_at,
        up.total_spent
      FROM claims_pending cp
      LEFT JOIN user_points up ON up.mobile_no = cp.phone;
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
      SELECT phone, country_code, tier_id, tier_unlock_at, tier_coins,
             coins_awarded, claim_mode, claim_type, status, failure_reason,
             dostt_user_id, created_at
      FROM claim_notifications
      ORDER BY created_at DESC;
    `,
  },
  {
    name: "view: v_user_performance",
    sql: `
      CREATE OR REPLACE VIEW v_user_performance AS
      SELECT
        u.phone,
        u.country_code,
        COUNT(DISTINCT ll.id)                                         AS login_attempts,
        COUNT(DISTINCT ll.id) FILTER (WHERE ll.status = 'success')    AS successful_logins,
        COUNT(DISTINCT ll.id) FILTER (WHERE ll.status = 'failed')     AS failed_logins,
        MAX(ll.created_at)    FILTER (WHERE ll.status = 'success')    AS last_login_at,
        COUNT(DISTINCT cn.id)                                         AS claim_attempts,
        COUNT(DISTINCT cn.id) FILTER (WHERE cn.status = 'success')    AS successful_claims,
        COUNT(DISTINCT cn.id) FILTER (WHERE cn.status = 'failed')     AS failed_claims,
        COALESCE(SUM(cn.coins_awarded) FILTER (WHERE cn.status = 'success'), 0) AS total_coins_claimed
      FROM users u
      LEFT JOIN login_logs ll ON ll.phone = u.phone
      LEFT JOIN claim_notifications cn ON cn.phone = u.phone
      GROUP BY u.phone, u.country_code;
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
