export interface Env {
    GithubOwner: string;
    GithubRepo: string;
    GithubPAT: string;
    DB: D1Database;
    AI: Ai;
    ADMIN_PASSWORD: string;
    IMAGE_RETENTION_DAYS?: string;
    AI_MODERATION_ENABLED?: string;
    AI_MODERATION_TIMEOUT_MS?: string;
    AI_MODERATION_FALLBACK?: string;
}
