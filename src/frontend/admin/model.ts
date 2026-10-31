export interface ImageRow {
  image_id: string;
  last_accessed_at: number;
  locked: number;
  deleting: number;
  moderation_status: 'pending' | 'approved' | 'flagged' | 'error';
  moderation_reason: string | null;
  moderation_error: string | null;
  moderation_response: string | null;
  uploader_ip: string | null;
  moderated_at: number | null;
  uploaded_at: number | null;
}
export interface AuditEvent {
  id: number; image_id: string | null; ip: string | null; action: string;
  error: string | null; model_response: string | null; outcome: string;
  created_at: number; current_status: string | null;
}
export type Api = <T>(path: string, init?: RequestInit, accept422?: boolean) => Promise<T>;
export type Run = (work: () => Promise<void>) => Promise<boolean>;
export interface Filters {
  search: string;
  status: string;
  source: string;
  retention: '' | 'unlocked' | 'locked' | 'deleting';
  expiry: string;
  minDays: string;
  maxDays: string;
}
export const emptyFilters: Filters = { search: '', status: '', source: '', retention: '', expiry: '', minDays: '', maxDays: '' };
export const statuses = [['', 'Any review status'], ['error', 'Needs review'], ['pending', 'Pending'], ['approved', 'Approved'], ['flagged', 'Flagged']];
export const sources = [['', 'Any approval source'], ['safe', 'AI approved'], ['exempt', 'IP exempt'], ['manual_approved', 'Manually approved'], ['moderation_disabled', 'AI disabled']];
export const lifecycles = [['', 'All images'], ['unlocked', 'Scheduled for cleanup'], ['locked', 'Locked / keep indefinitely'], ['deleting', 'Deletion in progress']];
export const expiries = [['', 'Any remaining time'], ['due', 'Already due'], ['1', 'Within 1 day'], ['2-3', '2–3 days'], ['4-6', '4–6 days'], ['7-14', '7–14 days'], ['15-21', '15–21 days'], ['22-30', '22–30 days'], ['over30', 'More than 30 days'], ['custom', 'Custom day range']];
export function filterError(filters: Filters): string {
  if (filters.search.trim().length > 64) return 'Search must be 64 characters or fewer.';
  if (filters.expiry !== 'custom') return '';
  const { minDays, maxDays } = filters;
  if (!minDays && !maxDays) return 'Enter at least one boundary for your day range.';
  if ([minDays, maxDays].some(value => value !== '' && (!/^\d+$/.test(value) || Number(value) > 1000000))) return 'Use whole days between 0 and 1,000,000.';
  if (minDays && maxDays && Number(minDays) > Number(maxDays)) return 'The minimum must be less than or equal to the maximum.';
  return '';
}
export function imageQuery(filters: Filters, cursor?: string | null): string {
  const query = new URLSearchParams();
  for (const field of ['search', 'status', 'source', 'retention'] as const) if (filters[field]) query.set(field, filters[field].trim());
  if (filters.expiry) {
    query.set('retention', 'unlocked');
    if (filters.expiry === 'due') query.set('maxDays', '0');
    else if (filters.expiry === 'custom') {
      if (filters.minDays) query.set('minDays', filters.minDays);
      if (filters.maxDays) query.set('maxDays', filters.maxDays);
    } else if (filters.expiry === 'over30') query.set('minDays', '31');
    else {
      const [min, max = min] = filters.expiry.split('-');
      query.set('minDays', min); query.set('maxDays', max);
    }
  }
  if (cursor) query.set('cursor', cursor);
  return query.toString();
}
export function filterTags(filters: Filters): { field: keyof Filters; label: string }[] {
  const tags: { field: keyof Filters; label: string }[] = [];
  if (filters.search) tags.push({ field: 'search', label: `Search: ${filters.search}` });
  if (filters.status) tags.push({ field: 'status', label: statuses.find(([value]) => value === filters.status)?.[1] ?? filters.status });
  if (filters.retention && !(filters.retention === 'unlocked' && filters.expiry)) tags.push({ field: 'retention', label: lifecycles.find(([value]) => value === filters.retention)![1] });
  if (filters.expiry) tags.push({ field: 'expiry', label: filters.expiry === 'custom' ? `${filters.minDays || '0'}–${filters.maxDays || '∞'} days` : expiries.find(([value]) => value === filters.expiry)![1] });
  if (filters.source) tags.push({ field: 'source', label: sources.find(([value]) => value === filters.source)?.[1] ?? filters.source });
  return tags;
}
export function removeFilter(filters: Filters, field: keyof Filters): Filters {
  if (field === 'expiry') return { ...filters, expiry: '', minDays: '', maxDays: '', retention: '' };
  return { ...filters, [field]: '' };
}
export const statusLabel = (status: string) => statuses.find(([key]) => key === status)?.[1] ?? status;
export const sourceLabel = (source: string | null) => sources.find(([key]) => key === source)?.[1] ?? source ?? 'No assessment';
export const dateLabel = (value: number | null) => value ? new Date(value).toLocaleString() : 'Not recorded';
export const remainingDays = (image: ImageRow, retentionMs: number) => Math.max(0, Math.ceil((image.last_accessed_at + retentionMs - Date.now()) / 86400000));
export const cleanupLabel = (image: ImageRow, retentionMs: number) => image.deleting ? 'Deleting' : image.locked ? 'Locked' : remainingDays(image, retentionMs) === 0 ? 'Ready for cleanup' : `${remainingDays(image, retentionMs)} days remaining`;
export const jsonBody = (value: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
