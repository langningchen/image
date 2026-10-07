ALTER TABLE image_access ADD COLUMN locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN (0, 1));
ALTER TABLE image_access ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0 CHECK(deleting IN (0, 1));
ALTER TABLE image_access ADD COLUMN deletion_started_at INTEGER;
ALTER TABLE image_access ADD COLUMN moderation_status TEXT NOT NULL DEFAULT 'pending' CHECK(moderation_status IN ('pending', 'approved', 'flagged', 'error'));
ALTER TABLE image_access ADD COLUMN moderation_reason TEXT;
ALTER TABLE image_access ADD COLUMN moderated_at INTEGER;
