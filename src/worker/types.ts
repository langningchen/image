export interface Env {
    GITHUB_OWNER: string;
    GITHUB_REPO: string;
    GITHUB_PAT: string;
    DB: D1Database;
    AI: Ai;
    ADMIN_PASSWORD: string;
    UPLOAD_PASSWORD?: string;
    IMAGE_RETENTION_DAYS?: string;
    AI_MODERATION_ENABLED?: string;
    AI_MODERATION_TIMEOUT_MS?: string;
    AI_MODERATION_FALLBACK?: string;
}
