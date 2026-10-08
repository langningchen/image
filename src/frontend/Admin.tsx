import IpLocation, { type IpDetails } from './components/IpLocation';
import AdminAnalytics, { type Stats } from './components/AdminAnalytics';
import { useState } from 'react';
import { Alert, Box, Button, Card, CardContent, CardMedia, Checkbox, FormControlLabel, Link, Chip, Container, CssBaseline, Stack, TextField, Typography, Tabs, Tab, MenuItem } from '@mui/material';
import { LLAMA_LICENSE_URL, LLAMA_POLICY_URL } from '../terms.ts';
import { prepareImage } from './prepareImage.ts';

interface ImageRow {
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

interface AuditEvent {
  id: number;
  image_id: string | null;
  ip: string | null;
  action: string;
  error: string | null;
  model_response: string | null;
  outcome: string;
  created_at: number;
  current_status: string | null;
}

function FailureDetails({ error, response }: { error: string | null; response: string | null }) {
  return <>
    {error && <Typography variant="caption" color="error" sx={{ display: 'block', overflowWrap: 'anywhere' }}>{error}</Typography>}
    {response && <Box component="details" sx={{ mt: .5 }}><Typography component="summary" variant="caption" sx={{ cursor: 'pointer' }}>Model response (untrusted text)</Typography><Box component="pre" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 11, maxHeight: 180, overflow: 'auto' }}>{response}</Box></Box>}
  </>;
}

export default function Admin() {
  const [tab, setTab] = useState('overview');
  const [password, setPassword] = useState('');
  const [credential, setCredential] = useState('');
  const [images, setImages] = useState<ImageRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [order, setOrder] = useState<'traffic' | 'uploads'>('traffic');
  const [days, setDays] = useState(7);
  const [ips, setIps] = useState<(IpDetails & { exempt: number; violations: number; window_started_at: number; banned_until: number })[]>([]);
  const [ipCursor, setIpCursor] = useState<string | null>(null);
  const [newIp, setNewIp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [licenseAccepted, setLicenseAccepted] = useState(false);
  const [operatorEligible, setOperatorEligible] = useState(false);
  const [modelActivated, setModelActivated] = useState(false);
  const [fallback, setFallback] = useState<'allow' | 'deny'>('allow');
  const [imageFilter, setImageFilter] = useState('');
  const [counts, setCounts] = useState<{ status: string; count: number }[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [auditCursor, setAuditCursor] = useState<number | null>(null);
  const [modelTest, setModelTest] = useState<{
    file: string;
    ok: boolean;
    verdict?: { approved: boolean; reason: string };
    responseType?: string;
    durationMs?: number;
    error?: string;
    modelResponse?: string;
  } | null>(null);

  async function testModel(file: File) {
    setBusy(true); setError(''); setModelTest(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('File read failed'));
        reader.readAsDataURL(file);
      });
      const image = await prepareImage(dataUrl, file.size);
      const response = await fetch('/api/admin/model-test', {
        method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'text/plain' }, body: image, cache: 'no-store',
      });
      const result = await response.json();
      if (response.status === 401) { setCredential(''); throw new Error('Incorrect or expired password'); }
      if (!response.ok && response.status !== 422) throw new Error(result.error ?? 'Model test failed');
      setModelTest({ ...result, file: file.name });
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function changeFallback(value: 'allow' | 'deny') {
    setBusy(true); setError('');
    try {
      const result = await api('/moderation-settings', credential, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fallback: value }) });
      setFallback(result.fallback);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function reviewImage(image: ImageRow, action: 'approve' | 'remove') {
    if (action === 'remove' && !window.confirm('Remove this image from server storage? Existing cached copies and Git history may remain.')) return;
    setBusy(true); setError('');
    try {
      await api(`/images/${image.image_id}/review`, credential, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
      await load(credential);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function moreAudit() {
    setBusy(true); setError('');
    try {
      const result = await api(`/assessment-audit?cursor=${auditCursor}`, credential);
      setAudit(previous => [...previous, ...result.events]); setAuditCursor(result.nextCursor);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function activateModel() {
    setBusy(true); setError(''); setModelActivated(false);
    try {
      await api('/model-license', credential, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agree: licenseAccepted, nonEuOperator: operatorEligible }) });
      setModelActivated(true);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function api(path: string, token: string, init: RequestInit = {}) {
    const response = await fetch(`/api/admin${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` }, cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401) setCredential('');
      throw new Error(response.status === 401 ? 'Incorrect or expired password' : 'Request failed. Please try again.');
    }
    return result;
  }

  async function load(token: string, next: string | null = null, filter = imageFilter) {
    setBusy(true); setError('');
    try {
      const query = new URLSearchParams({ status: filter });
      if (next) query.set('cursor', next);
      const result = await api(`/images?${query}`, token);
      if (!next) {
        const [traffic, controls, settings, history] = await Promise.all([api(`/stats?days=${days}&sort=${order}`, token), api('/ips', token), api('/moderation-settings', token), api('/assessment-audit', token)]);
        setStats(traffic); setIps(controls.ips); setIpCursor(controls.nextCursor);
        setFallback(settings.fallback); setCounts(settings.counts); setAudit(history.events); setAuditCursor(history.nextCursor);
      }
      setImages(previous => next ? [...previous, ...result.images] : result.images);
      setCursor(result.nextCursor);
      setCredential(token); setPassword('');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function toggle(image: ImageRow) {
    setBusy(true); setError('');
    try {
      await api(`/images/${image.image_id}/lock`, credential, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locked: !image.locked }) });
      setImages(previous => previous.map(row => row.image_id === image.image_id ? { ...row, locked: row.locked ? 0 : 1 } : row));
      setStats(await api(`/stats?days=${days}&sort=${order}`, credential));
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function updateIp(ip: string, action: string) {
    setBusy(true); setError('');
    try {
      await api('/ips', credential, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip, action }) });
      const controls = await api('/ips', credential);
      setIps(controls.ips); setIpCursor(controls.nextCursor); setNewIp('');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function changeDays(value: number) {
    setDays(value); setBusy(true); setError('');
    try { setStats(await api(`/stats?days=${value}&sort=${order}`, credential)); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function changeOrder(value: 'traffic' | 'uploads') {
    setOrder(value); setBusy(true); setError('');
    try { setStats(await api(`/stats?days=${days}&sort=${value}`, credential)); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function moreIps() {
    setBusy(true); setError('');
    try {
      const controls = await api(`/ips?cursor=${encodeURIComponent(ipCursor!)}`, credential);
      setIps(previous => [...previous, ...controls.ips]); setIpCursor(controls.nextCursor);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <><CssBaseline /><Container maxWidth={false} sx={{ py: 1.5, px: { xs: 1.5, sm: 2 }, minHeight: '100dvh', display: credential ? 'block' : 'flex', flexDirection: 'column', bgcolor: 'grey.50', '& .MuiCardContent-root': { p: 1.5, '&:last-child': { pb: 1.5 } } }}>
    {credential && <Stack direction="row" sx={{ mb: 1, justifyContent: 'space-between', alignItems: 'center' }}>
      <Typography variant="h5" sx={{ fontWeight: 600 }}>Image Administration</Typography>
      {credential && <Stack direction="row" spacing={.5}>
        <Button size="small" disabled={busy} onClick={() => load(credential)}>Refresh</Button>
        <Button size="small" disabled={busy} onClick={() => { setCredential(''); setImages([]); setCursor(null); setStats(null); setIps([]); setAudit([]); setAuditCursor(null); setCounts([]); setLicenseAccepted(false); setOperatorEligible(false); setModelActivated(false); setModelTest(null); setError(''); }}>Sign out</Button>
      </Stack>}
    </Stack>}
    {credential && error && <Alert severity="error" sx={{ mb: 1.5 }}>{error}</Alert>}
    {!credential ? <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}><Card sx={{ width: '100%', maxWidth: 360 }}><CardContent>
      <Typography variant="h5" sx={{ fontWeight: 600, textAlign: 'center', mb: 2 }}>Image Administration</Typography>
      {error && <Alert severity="error" sx={{ mb: 1.5 }}>{error}</Alert>}
      <Box component="form" onSubmit={event => { event.preventDefault(); void load(password); }}>
        <TextField size="small" fullWidth label="Admin password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} sx={{ mb: 1.5 }} />
        <Button fullWidth variant="contained" type="submit" disabled={busy || !password}>Sign in</Button>
      </Box>
    </CardContent></Card></Box> : <>
      <Tabs value={tab} onChange={(_, value) => setTab(value)} variant="scrollable" scrollButtons="auto" aria-label="Administration sections" sx={{ mb: 1.5, minHeight: 40, borderBottom: 1, borderColor: 'divider', '& .MuiTab-root': { minHeight: 40, py: 1, minWidth: 80 } }}>
        <Tab value="overview" label="Overview" /><Tab value="images" label="Images / Review" /><Tab value="audit" label="Assessment audit" /><Tab value="ips" label="IP controls" /><Tab value="model" label="Model setup" />
      </Tabs>
      {tab === 'model' && <Card variant="outlined"><CardContent>
        <Typography variant="h6">When AI assessment is unavailable</Typography>
        <Typography variant="body2" sx={{ mb: 1 }}>Applies to provider errors, timeouts, malformed responses and inconclusive verdicts. Explicitly prohibited content is always rejected. Allowed fallback images are marked for manual review; denied attempts retain an audit record without storing the image.</Typography>
        <TextField select label="AI failure fallback" size="small" value={fallback} disabled={busy} onChange={event => changeFallback(event.target.value as 'allow' | 'deny')} sx={{ mb: 3, minWidth: 250 }}>
          <MenuItem value="allow">Allow upload (default)</MenuItem><MenuItem value="deny">Deny upload</MenuItem>
        </TextField>
        <Typography variant="h6">Activate image assessment</Typography>
        <Typography variant="body2" sx={{ mb: 1 }}>Before the first assessed upload, the Cloudflare account operator must accept the model license. This sends the required “agree” prompt using this Worker's AI binding. Upload users' consent does not replace the operator's acceptance.</Typography>
        <FormControlLabel control={<Checkbox checked={licenseAccepted} onChange={event => setLicenseAccepted(event.target.checked)} />} label={<span>As the authorized account operator, I agree to the <Link href={LLAMA_LICENSE_URL} target="_blank" rel="noopener">Llama 3.2 Community License</Link> and <Link href={LLAMA_POLICY_URL} target="_blank" rel="noopener">Acceptable Use Policy</Link>.</span>} />
        <FormControlLabel control={<Checkbox checked={operatorEligible} onChange={event => setOperatorEligible(event.target.checked)} />} label="I confirm the operator is not an individual domiciled in, or a company with its principal place of business in, the European Union." />
        <Box><Button variant="contained" disabled={busy || !licenseAccepted || !operatorEligible} onClick={activateModel}>Agree and activate model</Button></Box>
        {modelActivated && <Alert severity="success" sx={{ mt: 2 }}>Cloudflare accepted the activation request. Image assessment is ready.</Alert>}
        <Box sx={{ mt: 3 }}>
          <Typography variant="h6">Test image assessment</Typography>
          <Typography variant="body2" sx={{ mb: 1 }}>Send an image directly for assessment to see the actual verdict, response format and timing. This test does not host the image, apply fallback or record violations.</Typography>
          <Button variant="outlined" component="label" disabled={busy}>Select test image
            <input hidden disabled={busy} type="file" accept="image/jpeg,image/png,image/webp" onChange={event => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void testModel(file);
            }} />
          </Button>
          {modelTest && <Box sx={{ mt: 1.5 }}>
            <Typography variant="body2">{modelTest.file}</Typography>
            <Alert severity={!modelTest.ok ? 'error' : modelTest.verdict?.approved ? 'success' : 'warning'}>
              {modelTest.ok ? `Model verdict: ${modelTest.verdict?.approved ? 'Allow' : 'Reject'} · ${modelTest.verdict?.reason}` : `Assessment failed: ${modelTest.error}`}
            </Alert>
            {modelTest.ok && <Typography variant="caption">Response format: {modelTest.responseType} · {modelTest.durationMs} ms</Typography>}
            <FailureDetails error={null} response={modelTest.modelResponse ?? null} />
          </Box>}
        </Box>
      </CardContent></Card>}
      {tab === 'overview' && <>
        <Stack direction="row" spacing={1} sx={{ mb: 1.5, flexWrap: 'wrap' }}>{counts.map(row => <Chip key={row.status} label={`${row.status === 'error' ? 'Needs review' : row.status}: ${row.count}`} color={row.status === 'error' ? 'warning' : 'default'} onClick={() => { setTab('images'); setImageFilter(row.status); void load(credential, null, row.status); }} disabled={busy} />)}</Stack>
        <Stack direction="row" spacing={.75} sx={{ mb: 1.5 }}>{[7, 30, 90].map(value => <Button size="small" key={value} disabled={busy} variant={days === value ? 'contained' : 'outlined'} onClick={() => changeDays(value)}>Last {value} days</Button>)}</Stack>
        <AdminAnalytics stats={stats} busy={busy} order={order} onOrderChange={changeOrder} />
      </>}
      {tab === 'ips' && <>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 1.5 }}>
          <TextField label="IPv4 / IPv6 address" size="small" value={newIp} onChange={event => setNewIp(event.target.value)} sx={{ minWidth: { sm: 300 } }} />
          <Button size="small" variant="outlined" disabled={busy || !newIp.trim()} onClick={() => updateIp(newIp.trim(), 'exempt')}>Add exemption</Button>
          <Button size="small" variant="outlined" disabled={busy || !newIp.trim()} color="error" onClick={() => updateIp(newIp.trim(), 'ban')}>Ban for 24 hours</Button>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>Upload counts cover retained activity from the last 90 days.</Typography>
        <Stack spacing={.75}>{ips.map(ip => <Card key={ip.ip} variant="outlined"><CardContent>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1.5fr) minmax(200px, 1fr) 270px' }, alignItems: 'center', gap: .5 }}>
            <Box sx={{ minWidth: 0 }}><Typography variant="body2" sx={{ overflowWrap: 'anywhere', fontFamily: 'monospace' }}>{ip.ip}</Typography><IpLocation ip={ip} /></Box>
            <Box><Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Uploads: {ip.upload_requests} · {ip.successful_uploads} successful · {ip.failed_uploads} failed · {ip.uploads_today} today (UTC)</Typography>
            <Typography variant="caption" color="text.secondary">Violations: {ip.window_started_at > Date.now() - 86400000 ? ip.violations : 0}{ip.exempt ? ' · Exempt' : ''}{ip.banned_until > Date.now() ? ` · Banned until ${new Date(ip.banned_until).toLocaleString('en-US')}` : ''}</Typography></Box>
            <Stack direction="row" spacing={.5}>
              <Button size="small" disabled={busy || ip.ip === 'unknown'} onClick={() => updateIp(ip.ip, ip.exempt ? 'unexempt' : 'exempt')}>{ip.exempt ? 'Remove exemption' : 'Exempt'}</Button>
              <Button size="small" disabled={busy || ip.ip === 'unknown'} color={ip.banned_until > Date.now() ? 'primary' : 'error'} onClick={() => updateIp(ip.ip, ip.banned_until > Date.now() ? 'unban' : 'ban')}>{ip.banned_until > Date.now() ? 'Unban' : 'Ban for 24 hours'}</Button>
            </Stack>
          </Box>
        </CardContent></Card>)}{!ips.length && <Typography color="text.secondary">No IP controls configured</Typography>}{ipCursor && <Button disabled={busy} onClick={moreIps}>Load more IPs</Button>}</Stack>
      </>}
      {tab === 'images' && <>
        <TextField select size="small" label="Moderation status" value={imageFilter} disabled={busy} onChange={event => { setImageFilter(event.target.value); void load(credential, null, event.target.value); }} sx={{ minWidth: 240, mb: 1.5 }}>
          <MenuItem value="">All images</MenuItem><MenuItem value="error">AI failed / needs review</MenuItem><MenuItem value="pending">Pending / legacy</MenuItem><MenuItem value="approved">Approved / exempt</MenuItem><MenuItem value="flagged">Flagged</MenuItem>
        </TextField>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>Locked images are retained. Unlocking resumes cleanup based on the last access time.</Typography>
        {!images.length && <Typography color="text.secondary">No images yet</Typography>}
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 210px), 1fr))', gap: 1 }}>
          {images.map(image => <Card key={image.image_id} variant="outlined" sx={{ minWidth: 0 }}>
            <CardMedia component="img" image={`/${image.image_id}?search`} alt="Image preview" loading="lazy" sx={{ height: 140, objectFit: 'contain', bgcolor: 'grey.100' }} />
            <CardContent>
              <Typography noWrap title={image.image_id} sx={{ fontFamily: 'monospace', fontSize: 11, mb: .5 }}>{image.image_id}</Typography>
              <Chip size="small" color={image.moderation_status === 'error' ? 'warning' : image.moderation_status === 'flagged' ? 'error' : 'default'} label={image.moderation_status === 'error' ? 'AI failed · needs review' : image.moderation_status} />
              <Typography variant="caption" sx={{ display: 'block' }}>{image.moderation_reason ?? 'No assessment'} · {image.uploader_ip ?? 'Unknown uploader'}</Typography>
              {image.uploaded_at && <Typography variant="caption" sx={{ display: 'block' }}>Uploaded: {new Date(image.uploaded_at).toLocaleString()}</Typography>}
              {image.moderated_at && <Typography variant="caption" sx={{ display: 'block' }}>Reviewed: {new Date(image.moderated_at).toLocaleString()}</Typography>}
              <FailureDetails error={image.moderation_error} response={image.moderation_response} />
              <Stack direction="row" spacing={.5} sx={{ mt: 1 }}>
                <Button size="small" disabled={busy || !!image.deleting || image.moderation_reason === 'manual_approved'} onClick={() => reviewImage(image, 'approve')}>Approve</Button>
                <Button size="small" color="error" disabled={busy || !!image.deleting || !!image.locked} onClick={() => reviewImage(image, 'remove')}>Remove</Button>
                <Link href={`/${image.image_id}?search`} target="_blank" rel="noopener" sx={{ fontSize: 12, alignSelf: 'center' }}>View</Link>
              </Stack>
              <Typography variant="caption" color="text.secondary">{new Date(image.last_accessed_at).toLocaleString('en-US')}</Typography>
              <Typography variant="caption" sx={{ display: 'block' }}>{image.locked ? 'Retention paused' : image.deleting ? 'Cleanup in progress' : `Cleanup eligible in ${Math.max(0, Math.ceil((image.last_accessed_at + (stats?.retention.retentionMs ?? 7 * 86400000) - Date.now()) / 86400000))} days`}</Typography>
              <Stack direction="row" sx={{ mt: .75, alignItems: 'center', justifyContent: 'space-between' }}>
                <Chip size="small" label={image.deleting ? 'Deleting' : image.locked ? 'Locked' : 'Unlocked'} color={image.locked ? 'primary' : 'default'} />
                <Button size="small" disabled={busy || !!image.deleting} onClick={() => toggle(image)}>{image.locked ? 'Unlock' : 'Lock'}</Button>
              </Stack>
            </CardContent>
          </Card>)}
        </Box>
        {cursor && <Button disabled={busy} onClick={() => load(credential, cursor)} sx={{ mt: 1.5 }}>Load more</Button>}
      </>}
      {tab === 'audit' && <>
        <Typography variant="body2" sx={{ mb: 1.5 }}>AI failure decisions and manual reviews, retained for 90 days. Denied attempts have no stored image. Pending means the storage outcome has not been confirmed. Removed files may remain in caches or Git history.</Typography>
        <Stack spacing={1}>{audit.map(event => <Card key={event.id} variant="outlined"><CardContent>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            {event.image_id && event.current_status && <Box component="img" src={`/${event.image_id}?search`} alt="Audit image preview" loading="lazy" sx={{ width: 120, height: 100, objectFit: 'contain' }} />}
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography variant="body2">#{event.id} · {event.action} · {event.outcome}</Typography>
              <Typography variant="caption">{new Date(event.created_at).toLocaleString()} · {event.ip ?? 'Unknown IP'} · Current: {event.current_status ?? 'No stored image'}</Typography>
              {event.image_id && <Typography variant="caption" sx={{ display: 'block', overflowWrap: 'anywhere' }}>{event.image_id}</Typography>}
              <FailureDetails error={event.error} response={event.model_response} />
            </Box>
          </Stack>
        </CardContent></Card>)}{!audit.length && <Typography color="text.secondary">No assessment audit events</Typography>}</Stack>
        {auditCursor && <Button disabled={busy} onClick={moreAudit} sx={{ mt: 1.5 }}>Load more audit events</Button>}
      </>}
    </>}
  </Container></>;
}
