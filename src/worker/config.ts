import type { Env } from './types.ts';

function positiveNumber(value: string | undefined, fallback: number, maximum: number): number {
    if (value === undefined || value.trim() === '') return fallback;
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0 || number > maximum) throw new Error('Invalid numeric environment configuration');
    return number;
}

export function retentionMs(env: Env): number {
    return positiveNumber(env.IMAGE_RETENTION_DAYS, 7, 3650) * 86400000;
}
export function moderationEnabled(env: Env): boolean {
    if (env.AI_MODERATION_ENABLED === undefined || env.AI_MODERATION_ENABLED === 'true') return true;
    if (env.AI_MODERATION_ENABLED === 'false') return false;
    throw new Error('AI_MODERATION_ENABLED must be true or false');
}
export function moderationTimeoutMs(env: Env): number {
    return positiveNumber(env.AI_MODERATION_TIMEOUT_MS, 20000, 300000);
}
