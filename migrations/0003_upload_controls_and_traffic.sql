CREATE TABLE ip_controls (
    ip TEXT PRIMARY KEY NOT NULL,
    exempt INTEGER NOT NULL DEFAULT 0 CHECK(exempt IN (0, 1)),
    window_started_at INTEGER NOT NULL DEFAULT 0,
    violations INTEGER NOT NULL DEFAULT 0,
    banned_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE moderation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_moderation_events_created ON moderation_events(created_at);
CREATE TABLE traffic_daily (
    day TEXT NOT NULL,
    ip TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('upload', 'download')),
    requests INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    failed_requests INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(day, ip, direction)
);
