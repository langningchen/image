import IpLocation, { type IpDetails } from './components/IpLocation';
import AdminAnalytics, { type Stats } from './components/AdminAnalytics';
import { useState } from 'react';
import { Alert, Box, Button, Card, CardContent, CardMedia, Checkbox, FormControlLabel, Link, Chip, Container, CssBaseline, Stack, TextField, Typography, Tabs, Tab } from '@mui/material';
import { LLAMA_LICENSE_URL, LLAMA_POLICY_URL } from '../terms.ts';

interface ImageRow {
  image_id: string;
  last_accessed_at: number;
  locked: number;
  deleting: number;
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

  async function load(token: string, next: string | null = null) {
    setBusy(true); setError('');
    try {
      const result = await api(`/images${next ? `?cursor=${next}` : ''}`, token);
      if (!next) {
        const [traffic, controls] = await Promise.all([api(`/stats?days=${days}&sort=${order}`, token), api('/ips', token)]);
        setStats(traffic); setIps(controls.ips); setIpCursor(controls.nextCursor);
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
        <Button size="small" disabled={busy} onClick={() => { setCredential(''); setImages([]); setCursor(null); setStats(null); setIps([]); setError(''); }}>Sign out</Button>
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
      <Tabs value={tab} onChange={(_, value) => setTab(value)} aria-label="Administration sections" sx={{ mb: 1.5, minHeight: 40, borderBottom: 1, borderColor: 'divider', '& .MuiTab-root': { minHeight: 40, py: 1, minWidth: 80 } }}>
        <Tab value="overview" label="Overview" /><Tab value="images" label="Images" /><Tab value="ips" label="IP controls" /><Tab value="model" label="Model setup" />
      </Tabs>
      {tab === 'model' && <Card variant="outlined"><CardContent>
        <Typography variant="h6">Activate image assessment</Typography>
        <Typography variant="body2" sx={{ mb: 1 }}>Before the first assessed upload, the Cloudflare account operator must accept the model license. This sends the required “agree” prompt using this Worker's AI binding. Upload users' consent does not replace the operator's acceptance.</Typography>
        <FormControlLabel control={<Checkbox checked={licenseAccepted} onChange={event => setLicenseAccepted(event.target.checked)} />} label={<span>As the authorized account operator, I agree to the <Link href={LLAMA_LICENSE_URL} target="_blank" rel="noopener">Llama 3.2 Community License</Link> and <Link href={LLAMA_POLICY_URL} target="_blank" rel="noopener">Acceptable Use Policy</Link>.</span>} />
        <FormControlLabel control={<Checkbox checked={operatorEligible} onChange={event => setOperatorEligible(event.target.checked)} />} label="I confirm the operator is not an individual domiciled in, or a company with its principal place of business in, the European Union." />
        <Box><Button variant="contained" disabled={busy || !licenseAccepted || !operatorEligible} onClick={activateModel}>Agree and activate model</Button></Box>
        {modelActivated && <Alert severity="success" sx={{ mt: 2 }}>Cloudflare accepted the activation request. Image assessment is ready.</Alert>}
      </CardContent></Card>}
      {tab === 'overview' && <>
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
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>Locked images are retained. Unlocking resumes cleanup based on the last access time.</Typography>
        {!images.length && <Typography color="text.secondary">No images yet</Typography>}
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 210px), 1fr))', gap: 1 }}>
          {images.map(image => <Card key={image.image_id} variant="outlined" sx={{ minWidth: 0 }}>
            <CardMedia component="img" image={`/${image.image_id}?search`} alt="Image preview" loading="lazy" sx={{ height: 140, objectFit: 'contain', bgcolor: 'grey.100' }} />
            <CardContent>
              <Typography noWrap title={image.image_id} sx={{ fontFamily: 'monospace', fontSize: 11, mb: .5 }}>{image.image_id}</Typography>
              <Typography variant="caption" color="text.secondary">{new Date(image.last_accessed_at).toLocaleString('en-US')}</Typography>
              <Typography variant="caption" sx={{ display: 'block' }}>{image.locked ? 'Retention paused' : image.deleting ? 'Cleanup in progress' : `Cleanup eligible in ${Math.max(0, Math.ceil((image.last_accessed_at + 7 * 86400000 - Date.now()) / 86400000))} days`}</Typography>
              <Stack direction="row" sx={{ mt: .75, alignItems: 'center', justifyContent: 'space-between' }}>
                <Chip size="small" label={image.deleting ? 'Deleting' : image.locked ? 'Locked' : 'Unlocked'} color={image.locked ? 'primary' : 'default'} />
                <Button size="small" disabled={busy || !!image.deleting} onClick={() => toggle(image)}>{image.locked ? 'Unlock' : 'Lock'}</Button>
              </Stack>
            </CardContent>
          </Card>)}
        </Box>
        {cursor && <Button disabled={busy} onClick={() => load(credential, cursor)} sx={{ mt: 1.5 }}>Load more</Button>}
      </>}
    </>}
  </Container></>;
}
