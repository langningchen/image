import { AdminButton } from './admin/ui';
import { useEffect, useMemo, useState } from 'react';
import AdminAnalytics, { type Stats } from './components/AdminAnalytics';
import ImageLibrary from './admin/ImageLibrary';
import ModelSettings from './admin/ModelSettings';
import ActivityLog from './admin/ActivityLog';
import NetworkAccess, { type ManagedIp } from './admin/NetworkAccess';
import { emptyFilters, filterError, imageQuery, jsonBody, type Api, type AuditEvent, type Filters, type ImageRow } from './admin/model';
import { Icon } from './admin/ui';
import { Alert, Box, Button, Card, CardContent, CssBaseline, TextField, Typography } from '@mui/material';
import AdminLayout from './admin/Layout';

interface Settings { fallback: 'allow' | 'deny'; counts: { status: string; count: number }[] }
interface ImagePage { images: ImageRow[]; nextCursor: string | null }
interface IpPage { ips: ManagedIp[]; nextCursor: string | null }
interface AuditPage { events: AuditEvent[]; nextCursor: number | null }
const sections = [
  { id: 'overview', title: 'Overview', description: 'A clear view of your image library and its activity.', icon: 'overview' },
  { id: 'images', title: 'Image library', description: 'Find, review and take care of your images.', icon: 'images' },
  { id: 'audit', title: 'Review activity', description: 'A record of assessment decisions and manual reviews.', icon: 'audit' },
  { id: 'ips', title: 'Network access', description: 'Manage trusted addresses and upload restrictions.', icon: 'ips' },
  { id: 'settings', title: 'Settings', description: 'Your upload policy, assessment model and diagnostics.', icon: 'settings' },
] as const;
type Section = typeof sections[number]['id'];
function createApi(token: string, unauthorized: () => void): Api {
  return async <T,>(path: string, init: RequestInit = {}, accept422 = false): Promise<T> => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(`/api/admin${path}`, { ...init, headers, cache: 'no-store' });
    if (response.status === 401) { unauthorized(); throw new Error('Incorrect or expired password. Please sign in again.'); }
    const result = await response.json();
    if (!response.ok && !(accept422 && response.status === 422)) throw new Error(result.error ?? 'The request failed. Please try again.');
    return result as T;
  };
}
function Brand() {
  return <Typography variant="h6">Image Administration</Typography>;
}
function Workspace({ api, onSignOut }: { api: Api; onSignOut: () => void }) {
  const [section, setSection] = useState<Section>('overview');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [images, setImages] = useState<ImageRow[]>([]);
  const [imageCursor, setImageCursor] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [stats, setStats] = useState<Stats | null>(null);
  const [days, setDays] = useState(7);
  const [order, setOrder] = useState<'traffic' | 'uploads'>('traffic');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [ips, setIps] = useState<ManagedIp[]>([]);
  const [ipCursor, setIpCursor] = useState<string | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [auditCursor, setAuditCursor] = useState<number | null>(null);
  const [updated, setUpdated] = useState<number | null>(null);
  const current = sections.find(item => item.id === section)!;
  const needsReview = settings?.counts.find(row => row.status === 'error')?.count ?? 0;
  async function run(work: () => Promise<void>): Promise<boolean> {
    setBusy(true); setError('');
    try { await work(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Something went wrong. Please try again.'); return false; }
    finally { setBusy(false); }
  }
  async function refresh(signal?: AbortSignal) {
    const init = { signal };
    const [library, traffic, policies, addresses, history] = await Promise.all([
      api<ImagePage>(`/images?${imageQuery(filters)}`, init), api<Stats>(`/stats?days=${days}&sort=${order}`, init),
      api<Settings>('/moderation-settings', init), api<IpPage>('/ips', init), api<AuditPage>('/assessment-audit', init),
    ]);
    if (signal?.aborted) return;
    setImages(library.images); setImageCursor(library.nextCursor); setStats(traffic); setSettings(policies);
    setIps(addresses.ips); setIpCursor(addresses.nextCursor); setEvents(history.events); setAuditCursor(history.nextCursor); setUpdated(Date.now());
  }
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch(cause => { if (!controller.signal.aborted) setError((cause as Error).message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
    // Each authenticated workspace owns a fresh initial snapshot.
  }, [api]);
  async function loadImages(nextFilters: Filters, cursor?: string | null) {
    const validation = filterError(nextFilters);
    if (validation) throw new Error(validation);
    const result = await api<ImagePage>(`/images?${imageQuery(nextFilters, cursor)}`);
    setImages(previous => cursor ? [...previous, ...result.images] : result.images);
    setImageCursor(result.nextCursor); setFilters(nextFilters);
  }
  function explore(nextFilters: Filters) { setSection('images'); void run(() => loadImages(nextFilters)); }
  async function changePeriod(value: number, nextOrder = order) {
    const traffic = await api<Stats>(`/stats?days=${value}&sort=${nextOrder}`);
    setDays(value); setOrder(nextOrder); setStats(traffic); setUpdated(Date.now());
  }
  const updateIp = (ip: string, action: string) => run(async () => {
    await api('/ips', jsonBody({ ip, action }, 'PATCH'));
    const result = await api<IpPage>('/ips'); setIps(result.ips); setIpCursor(result.nextCursor);
  });
  return <div className="admin-ui admin-shell">
    <a className="skip-link" href="#admin-main">Skip to content</a>
    <aside className="sidebar"><Brand /><nav aria-label="Administration">{sections.map(item => <AdminButton key={item.id} className={`nav-item ${section === item.id ? 'active' : ''}`} aria-label={item.title} title={item.title} aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)}><Icon name={item.icon} /><span>{item.title}</span>{item.id === 'images' && needsReview > 0 && <span className="nav-count">{needsReview}</span>}</AdminButton>)}</nav><div className="sidebar-bottom"><AdminButton className="nav-item" aria-label="Sign out" title="Sign out" disabled={busy} onClick={onSignOut}><Icon name="logout" /><span>Sign out</span></AdminButton></div></aside>
    <div className="workspace"><header className="topbar"><div className="breadcrumb">Workspace <Icon name="chevron" size={12} /><span>{current.title}</span></div><span className="topbar-status">Authenticated session</span></header>
      <main id="admin-main" className="main-content" aria-busy={busy}><div className="page-heading"><div><h1>{current.title}</h1><p>{current.description}</p></div><div className="heading-actions">{section === 'overview' && <div className="segmented" aria-label="Analytics period">{[7, 30, 90].map(value => <AdminButton key={value} disabled={busy} aria-pressed={days === value} className={days === value ? 'selected' : ''} onClick={() => void run(() => changePeriod(value))}>{value} days</AdminButton>)}</div>}<AdminButton className="button refresh-button" disabled={busy} onClick={() => void run(() => refresh())}><Icon name="refresh" size={16} /><span>{busy ? 'Updating…' : 'Refresh'}</span></AdminButton></div></div>
        {error && <Alert severity="error" className="error-banner"><span>{error}</span><AdminButton className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><Icon name="close" size={17} /></AdminButton></Alert>}
        {busy && <div className="loading-line" role="status" aria-label="Loading" />}
        {section === 'overview' && <>{needsReview > 0 && <AdminButton className="review-banner" disabled={busy} onClick={() => explore({ ...emptyFilters, status: 'error' })}><span className="review-banner-icon"><Icon name="audit" /></span><span><strong>{needsReview} {needsReview === 1 ? 'image needs' : 'images need'} your attention</strong><small>AI assessment was unavailable. Review these images when you’re ready.</small></span><span className="review-banner-action">Open review queue<Icon name="arrow" size={17} /></span></AdminButton>}{stats ? <AdminAnalytics stats={stats} busy={busy} order={order} onOrderChange={value => void run(() => changePeriod(days, value))} onExplore={explore} /> : <div className="panel initial-loading"><Icon name="overview" size={28} /><h3>{busy ? 'Getting your workspace ready…' : 'Could not load the overview'}</h3><p>{busy ? 'Gathering your library and activity.' : 'Use Refresh to try again.'}</p></div>}<div className="overview-footer"><span>{updated ? `Updated ${new Date(updated).toLocaleTimeString()}` : 'Awaiting data'}</span><AdminButton className="text-link" disabled={busy} onClick={() => explore(emptyFilters)}>Explore your library<Icon name="arrow" size={15} /></AdminButton></div></>}
        {section === 'images' && <ImageLibrary images={images} filters={filters} busy={busy} cursor={imageCursor} retentionMs={stats?.retention.retentionMs ?? 7 * 86400000} onApply={value => void run(() => loadImages(value))} onMore={() => void run(() => loadImages(filters, imageCursor))} onAction={(image, action) => run(async () => { if (action === 'lock') await api(`/images/${image.image_id}/lock`, jsonBody({ locked: !image.locked }, 'PATCH')); else await api(`/images/${image.image_id}/review`, jsonBody({ action })); await refresh(); })} />}
        {section === 'audit' && <ActivityLog events={events} cursor={auditCursor} busy={busy} onMore={() => void run(async () => { const result = await api<AuditPage>(`/assessment-audit?cursor=${auditCursor}`); setEvents(previous => [...previous, ...result.events]); setAuditCursor(result.nextCursor); })} />}
        {section === 'ips' && <NetworkAccess ips={ips} cursor={ipCursor} busy={busy} onUpdate={updateIp} onMore={() => void run(async () => { const result = await api<IpPage>(`/ips?cursor=${encodeURIComponent(ipCursor!)}`); setIps(previous => [...previous, ...result.ips]); setIpCursor(result.nextCursor); })} />}
        {section === 'settings' && settings && <ModelSettings key={settings.fallback} api={api} run={run} busy={busy} fallback={settings.fallback} onFallback={fallback => setSettings(previous => previous ? { ...previous, fallback } : previous)} />}
      </main><footer className="workspace-footer"><span>Image administration</span></footer>
    </div>
  </div>;
}
function AdminContent() {
  const [credential, setCredential] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const api = useMemo(() => createApi(credential, () => { setCredential(''); setError('Your session expired. Please sign in again.'); }), [credential]);
  async function signIn() {
    setBusy(true); setError('');
    try { await createApi(password, () => {})<Settings>('/moderation-settings'); setCredential(password); setPassword(''); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  if (credential) return <Workspace key={credential} api={api} onSignOut={() => { setCredential(''); setError(''); }} />;
  return <Box className="admin-ui" sx={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', bgcolor: 'grey.50', p: 2 }}><Card sx={{ width: '100%', maxWidth: 360 }}><CardContent>
    <Typography variant="h5" sx={{ textAlign: 'center', mb: 2 }}>Image Administration</Typography>
    {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
    <Box component="form" onSubmit={event => { event.preventDefault(); void signIn(); }}>
      <TextField size="small" fullWidth label="Admin password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} sx={{ mb: 2 }} />
      <Button fullWidth variant="contained" type="submit" disabled={busy || !password}>{busy ? 'Signing in…' : 'Sign in'}</Button>
    </Box>
  </CardContent></Card></Box>;
}
export default function Admin() {
  return <><CssBaseline /><AdminLayout /><AdminContent /></>;
}
