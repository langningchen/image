CREATE TABLE moderation_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    fallback TEXT NOT NULL DEFAULT 'allow' CHECK(fallback IN ('allow', 'deny'))
);
INSERT INTO moderation_settings (id, fallback) VALUES (1, 'allow');

ALTER TABLE image_access ADD COLUMN uploader_ip TEXT;
ALTER TABLE image_access ADD COLUMN uploaded_at INTEGER;
ALTER TABLE image_access ADD COLUMN moderation_error TEXT;
ALTER TABLE image_access ADD COLUMN moderation_response TEXT;
CREATE INDEX idx_image_moderation_status ON image_access(moderation_status, image_id);

-- No foreign key: preserve the audit after an image is removed or expires.
CREATE TABLE assessment_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id TEXT,
    ip TEXT,
    action TEXT NOT NULL CHECK(action IN ('fallback_allow', 'fallback_deny', 'manual_approve', 'manual_remove')),
    error TEXT,
    model_response TEXT,
    outcome TEXT NOT NULL CHECK(outcome IN ('pending', 'uploaded', 'denied', 'approved', 'removed', 'storage_failed')),
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_assessment_audit_created_at ON assessment_audit(created_at);
