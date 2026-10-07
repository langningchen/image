import IpLocation, { type IpDetails } from './IpLocation';
import RetentionChart, { type RetentionStats } from './RetentionChart';
import { useEffect, useRef, useState } from 'react';
import { Box, Card, CardContent, Stack, Typography } from '@mui/material';

interface Daily { day: string; direction: 'upload' | 'download'; requests: number; bytes: number; ips: number; failed_requests: number }
export interface Stats {
  daily: Daily[];
  ips: (IpDetails & { requests: number; bytes: number; failed_requests: number })[];
  totals: { requests: number; bytes: number; ips: number; upload_requests: number };
  since: string;
  retention: RetentionStats;
}
export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 3);
  return `${(value / 1024 ** index).toFixed(1)} ${['B', 'KB', 'MB', 'GB'][index]}`;
}

function DailyChart({ stats, metric, title }: { stats: Stats; metric: 'requests' | 'bytes' | 'ips'; title: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(400);
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(1, Math.floor(entry.contentRect.width))));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const days: string[] = [];
  for (let time = Date.parse(stats.since); time <= Date.now(); time += 86400000) days.push(new Date(time).toISOString().slice(0, 10));
  const rows = days.map(day => ({ day, upload: stats.daily.find(row => row.day === day && row.direction === 'upload')?.[metric] ?? 0,
    download: stats.daily.find(row => row.day === day && row.direction === 'download')?.[metric] ?? 0 }));
  const max = Math.max(1, ...rows.flatMap(row => [row.upload, row.download]));
  const gap = Math.max(1, width - 48) / Math.max(rows.length, 1);
  const labelStep = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor((width - 48) / 60))));
  const unit = (value: number) => metric === 'bytes' ? formatBytes(value) : Math.round(value).toLocaleString('en-US');
  return <Card variant="outlined" sx={{ minWidth: 0 }}><CardContent>
    <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', gap: .5, flexWrap: 'wrap', mb: .5 }}>
      <Typography variant="subtitle2">{title}</Typography>
      <Stack direction="row" spacing={1}><Typography variant="caption" color="primary">■ Uploads</Typography><Typography variant="caption" sx={{ color: '#00897b' }}>■ Downloads</Typography></Stack>
    </Stack>
    <Box ref={container} sx={{ width: '100%', minWidth: 0 }}>
      <svg width="100%" height="190" viewBox={`0 0 ${width} 190`} role="img" aria-label={title} style={{ display: 'block' }}>
        {[0, 0.5, 1].map(fraction => <g key={fraction}>
          <line x1="44" x2={width} y1={160 - fraction * 140} y2={160 - fraction * 140} stroke="#e0e0e0" />
          <text x="0" y={164 - fraction * 140} fontSize="10" fill="#666">{unit(max * fraction)}</text>
        </g>)}
        {rows.map((row, index) => <g key={row.day}>
          <rect x={46 + index * gap} y={160 - row.upload / max * 140} width={gap * .35} height={row.upload / max * 140} fill="#1976d2"><title>{row.day} Uploads: {unit(row.upload)}</title></rect>
          <rect x={46 + index * gap + gap * .38} y={160 - row.download / max * 140} width={gap * .35} height={row.download / max * 140} fill="#00897b"><title>{row.day} Downloads: {unit(row.download)}</title></rect>
          {((index % labelStep === 0 && index < rows.length - labelStep / 2) || index === rows.length - 1) &&
            <text x={Math.min(46 + index * gap, width - 30)} y="180" fontSize="10" fill="#666">{row.day.slice(5)}</text>}
        </g>)}
      </svg>
    </Box>
  </CardContent></Card>;
}

export default function AdminAnalytics({ stats, busy, order, onOrderChange }: { stats: Stats | null; busy: boolean; order: 'traffic' | 'uploads'; onOrderChange: (order: 'traffic' | 'uploads') => void }) {
  if (!stats) return null;
  const value = (row: Stats['ips'][number]) => order === 'uploads' ? row.upload_requests : row.bytes;
  const peak = Math.max(1, ...stats.ips.map(value));
  return <Stack spacing={1.25}>
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))' }, gap: 1 }}>
      {[['Requests', stats.totals.requests.toLocaleString('en-US')], ['Upload attempts', stats.totals.upload_requests.toLocaleString('en-US')], ['Total traffic', formatBytes(stats.totals.bytes)], ['Active IPs', stats.totals.ips.toLocaleString('en-US')]].map(([label, value]) =>
        <Card key={label} variant="outlined"><CardContent>
          <Typography variant="caption" color="text.secondary">{label}</Typography>
          <Typography sx={{ fontSize: { xs: 19, sm: 24 }, fontWeight: 600 }}>{value}</Typography>
        </CardContent></Card>)}
    </Box>
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(3, minmax(0, 1fr))' }, gap: 1 }}>
      <DailyChart stats={stats} metric="bytes" title="Daily traffic" />
      <DailyChart stats={stats} metric="requests" title="Daily requests" />
      <DailyChart stats={stats} metric="ips" title="Daily active IPs" />
    </Box>
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(300px, 1fr) minmax(0, 2fr)' }, gap: 1, alignItems: 'start' }}>
      <RetentionChart stats={stats.retention} />
      <Card variant="outlined" sx={{ minWidth: 0 }}><CardContent>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 1 }}>
        <Typography variant="subtitle2">Top IPs by {order}</Typography>
        <Box component="select" aria-label="IP ranking order" disabled={busy} value={order} onChange={event => onOrderChange(event.target.value as 'traffic' | 'uploads')} sx={{ p: .5, bgcolor: 'transparent', border: '1px solid #ddd', borderRadius: 1, fontSize: 12 }}>
          <option value="traffic">Traffic</option><option value="uploads">Upload attempts</option>
        </Box>
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'repeat(2, minmax(0, 1fr))' }, columnGap: 3, rowGap: 1 }}>
        {stats.ips.map(row => <Box key={row.ip} sx={{ minWidth: 0 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant="caption" sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>{row.ip}</Typography>
            <Typography variant="caption" color="text.secondary">{formatBytes(row.bytes)} · {row.requests} requests · {row.failed_requests} failed</Typography>
          </Box>
          <IpLocation ip={row} />
          <Typography variant="caption" color="text.secondary">Uploads: {row.upload_requests} · {row.successful_uploads} successful · {row.failed_uploads} failed · {row.uploads_today} today (UTC)</Typography>
          <Box sx={{ height: 4, mt: .25, borderRadius: 1, bgcolor: 'grey.100' }}><Box sx={{ height: '100%', borderRadius: 1, bgcolor: '#1976d2', width: `${Math.max(1, value(row) / peak * 100)}%` }} /></Box>
        </Box>)}
      </Box>
      {!stats.ips.length && <Typography variant="body2" color="text.secondary">No traffic data yet</Typography>}
    </CardContent></Card>
    </Box>
  </Stack>;
}
