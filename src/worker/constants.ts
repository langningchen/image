export const IMAGE_ID_PATTERN = /^[a-z]{32}$/;
export const IMAGE_PATH_PATTERN = /^[a-z]{32}\.(jpeg|png|webp)$/;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
};
