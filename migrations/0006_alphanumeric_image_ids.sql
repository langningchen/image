-- SQLite cannot alter a CHECK constraint in place. Preserve every existing
-- column while rebuilding the table to accept lowercase letters and digits.
CREATE TABLE image_access_alphanumeric (
    image_id TEXT PRIMARY KEY NOT NULL CHECK(length(image_id) = 32 AND image_id NOT GLOB '*[^0-9a-z]*'),
    last_accessed_at INTEGER NOT NULL CHECK(last_accessed_at >= 0),
    locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN (0, 1)),
    deleting INTEGER NOT NULL DEFAULT 0 CHECK(deleting IN (0, 1)),
    deletion_started_at INTEGER,
    moderation_status TEXT NOT NULL DEFAULT 'pending' CHECK(moderation_status IN ('pending', 'approved', 'flagged', 'error')),
    moderation_reason TEXT,
    moderated_at INTEGER,
    uploader_ip TEXT,
    uploaded_at INTEGER,
    moderation_error TEXT,
    moderation_response TEXT
);

INSERT INTO image_access_alphanumeric (
    image_id, last_accessed_at, locked, deleting, deletion_started_at,
    moderation_status, moderation_reason, moderated_at,
    uploader_ip, uploaded_at, moderation_error, moderation_response
)
SELECT image_id, last_accessed_at, locked, deleting, deletion_started_at,
    moderation_status, moderation_reason, moderated_at,
    uploader_ip, uploaded_at, moderation_error, moderation_response
FROM image_access;

DROP TABLE image_access;
ALTER TABLE image_access_alphanumeric RENAME TO image_access;
CREATE INDEX idx_image_access_last_accessed_at ON image_access(last_accessed_at);
CREATE INDEX idx_image_moderation_status ON image_access(moderation_status, image_id);
