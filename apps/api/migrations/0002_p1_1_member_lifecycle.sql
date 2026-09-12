PRAGMA foreign_keys = ON;

ALTER TABLE members ADD COLUMN invited_at TEXT;
ALTER TABLE members ADD COLUMN first_login_at TEXT;
ALTER TABLE members ADD COLUMN last_login_at TEXT;

UPDATE members
SET invited_at = created_at
WHERE invited_at IS NULL;

CREATE INDEX idx_members_enabled_role ON members(enabled, role);
CREATE INDEX idx_members_last_login ON members(last_login_at);
