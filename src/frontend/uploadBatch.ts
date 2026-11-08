// GitHub Contents writes share one branch. Serialize decoding and uploads to
// avoid concurrent commits and retaining every selected image in memory.
export async function uploadBatch<T>(files: readonly T[], upload: (file: T) => Promise<string>, onUploaded: (id: string) => void, onProgress: (percent: number) => void) {
  let uploaded = 0;
  let completed = 0;
  const errors: string[] = [];
  for (const file of files) {
    try {
      const id = await upload(file);
      onUploaded(id);
      uploaded++;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Upload failed');
    } finally {
      completed++;
      onProgress(completed / files.length * 100);
    }
  }
  return { uploaded, errors };
}
