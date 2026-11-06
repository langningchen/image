export interface UploadLimits {
  maxImageDimension: number | null;
  maxUploadBytes: number | null;
}

export const DEFAULT_UPLOAD_LIMITS: Readonly<UploadLimits> = {
  maxImageDimension: 1920,
  maxUploadBytes: 10 * 1024 * 1024,
};

export const MEBIBYTE = 1024 * 1024;
