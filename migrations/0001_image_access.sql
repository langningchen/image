CREATE TABLE image_access (
    image_id TEXT PRIMARY KEY NOT NULL CHECK(length(image_id) = 32 AND image_id NOT GLOB '*[^a-z]*'),
    last_accessed_at INTEGER NOT NULL CHECK(last_accessed_at >= 0)
);
-- Supports inactivity queries; updating this index also counts toward D1 writes.
CREATE INDEX idx_image_access_last_accessed_at ON image_access(last_accessed_at);
