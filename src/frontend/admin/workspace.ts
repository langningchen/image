import type { UploadLimits } from '../../uploadLimits.ts';
import type { Stats } from '../components/AdminAnalytics.tsx';
import type { ManagedIp } from './NetworkAccess.tsx';
import { imageQuery, type Api, type AuditEvent, type Filters, type ImageRow } from './model.ts';

export type Section = 'overview' | 'images' | 'audit' | 'ips' | 'settings';
export interface Settings { fallback: 'allow' | 'deny'; counts: { status: string; count: number }[]; retentionMs: number }
export interface ImagePage { images: ImageRow[]; nextCursor: string | null }
export interface IpPage { ips: ManagedIp[]; nextCursor: string | null }
export interface AuditPage { events: AuditEvent[]; nextCursor: number | null }
interface Snapshot {
  library?: ImagePage;
  stats?: Stats;
  settings?: Settings;
  limits?: UploadLimits;
  addresses?: IpPage;
  history?: AuditPage;
}

export async function loadWorkspaceSection(api: Api, section: Section, filters: Filters, days: number, order: 'traffic' | 'uploads', signal?: AbortSignal): Promise<Snapshot> {
  const init = { signal };
  if (section === 'overview') {
    const [stats, settings] = await Promise.all([
      api<Stats>(`/stats?days=${days}&sort=${order}`, init), api<Settings>('/moderation-settings', init),
    ]);
    return { stats, settings };
  }
  if (section === 'images') {
    const [library, settings] = await Promise.all([
      api<ImagePage>(`/images?${imageQuery(filters)}`, init), api<Settings>('/moderation-settings', init),
    ]);
    return { library, settings };
  }
  if (section === 'settings') {
    const [settings, limits] = await Promise.all([
      api<Settings>('/moderation-settings', init), api<UploadLimits>('/upload-settings', init),
    ]);
    return { settings, limits };
  }
  if (section === 'ips') return { addresses: await api<IpPage>('/ips', init) };
  return { history: await api<AuditPage>('/assessment-audit', init) };
}
