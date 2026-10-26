-- 0007: dashboard super-admin password, sessions and auth audit log

-- Single admin account (id is always 1). Only the scrypt hash is stored.
CREATE TABLE IF NOT EXISTS auth_admin (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash        TEXT NOT NULL,
  failed_attempts      INTEGER NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  last_login_at        TIMESTAMPTZ,
  password_changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sessions: only a SHA-256 of the random session token is stored. Sliding expiry.
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash    TEXT PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS auth_sessions_expires_idx ON auth_sessions (expires_at);

CREATE TABLE IF NOT EXISTS auth_audit (
  id          BIGSERIAL PRIMARY KEY,
  time        TIMESTAMPTZ NOT NULL DEFAULT now(),
  event       TEXT NOT NULL,      -- SETUP | LOGIN | LOGIN_FAILED | ACCOUNT_LOCKED | LOGIN_BLOCKED | LOGOUT | PASSWORD_CHANGED | PASSWORD_RESET
  ip          TEXT,
  user_agent  TEXT,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS auth_audit_time_idx ON auth_audit (time DESC);
