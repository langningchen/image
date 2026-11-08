-- Pending claims are a small subset; avoid scanning the library/audit history.
CREATE INDEX idx_image_pending_deletions ON image_access(deletion_started_at)
    WHERE deleting = 1;
CREATE INDEX idx_audit_pending_removal ON assessment_audit(image_id)
    WHERE action = 'manual_remove' AND outcome = 'pending';
