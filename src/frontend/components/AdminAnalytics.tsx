import { AdminButton, AdminSelect } from '../admin/ui';
import { useEffect, useRef, useState } from 'react';
import IpLocation, { type IpDetails } from './IpLocation';
import RetentionChart, { type RetentionStats } from './RetentionChart';
import type { Filters } from '../admin/model';
import { Icon } from '../admin/ui';

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
function ActivityChart({ stats }: { stats: Stats }) {
  const [metric, setMetric] = useState<'bytes' | 'requests' | 'ips'>('bytes');
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.floor(entry.contentRect.width))));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const days: string[] = [];
  for (let time = Date.parse(stats.since); time <= Date.now(); time += 86400000) days.push(new Date(time).toISOString().slice(0, 10));
  const rows = days.map(day => ({ day, upload: stats.daily.find(row => row.day === day && row.direction === 'upload')?.[metric] ?? 0, download: stats.daily.find(row => row.day === day && row.direction === 'download')?.[metric] ?? 0 }));
  const max = Math.max(1, ...rows.flatMap(row => [row.upload, row.download]));
  const gap = (width - 60) / Math.max(rows.length, 1);
  const labelStep = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor((width - 60) / 70))));
  const unit = (value: number) => metric === 'bytes' ? formatBytes(value) : Math.round(value).toLocaleString();
  return <section className="panel activity-panel"><div className="panel-heading"><div><h2>Activity</h2><p>Uploads and downloads over time · UTC</p></div><div className="segmented compact">{(['bytes', 'requests', 'ips'] as const).map(value => <AdminButton key={value} className={metric === value ? 'selected' : ''} aria-pressed={metric === value} onClick={() => setMetric(value)}>{value === 'bytes' ? 'Traffic' : value === 'ips' ? 'Active IPs' : 'Requests'}</AdminButton>)}</div></div>
    <div className="chart-key"><span><i style={{ background: '#1976d2' }} />Uploads</span><span><i style={{ background: '#00897b' }} />Downloads</span></div>
    <div ref={container} className="activity-chart"><svg width="100%" height="232" viewBox={`0 0 ${width} 232`} role="img" aria-label={`Daily ${metric}`}>
      {[0, .25, .5, .75, 1].map(fraction => <g key={fraction}><line x1="50" x2={width - 5} y1={195 - fraction * 170} y2={195 - fraction * 170} stroke="#e0e0e0" strokeDasharray="3 5" /><text x="0" y={199 - fraction * 170} fontSize="10" fill="#666">{unit(max * fraction)}</text></g>)}
      {rows.map((row, index) => <g key={row.day}><rect x={52 + index * gap + gap * .13} y={195 - row.upload / max * 170} width={Math.max(1, gap * .29)} height={row.upload / max * 170} rx="2" fill="#1976d2"><title>{row.day} · Uploads: {unit(row.upload)}</title></rect><rect x={52 + index * gap + gap * .46} y={195 - row.download / max * 170} width={Math.max(1, gap * .29)} height={row.download / max * 170} rx="2" fill="#00897b"><title>{row.day} · Downloads: {unit(row.download)}</title></rect>{(index % labelStep === 0 || index === rows.length - 1) && <text x={Math.min(52 + index * gap, width - 34)} y="221" fontSize="10" fill="#666">{row.day.slice(5)}</text>}</g>)}
    </svg>{!stats.daily.length && <span className="chart-no-data">No activity in this period</span>}</div>
  </section>;
}
export default function AdminAnalytics({ stats, busy, order, onOrderChange, onExplore }: { stats: Stats; busy: boolean; order: 'traffic' | 'uploads'; onOrderChange: (order: 'traffic' | 'uploads') => void; onExplore: (filters: Filters) => void }) {
  const value = (row: Stats['ips'][number]) => order === 'uploads' ? row.upload_requests : row.bytes;
  const peak = Math.max(1, ...stats.ips.map(value));
  return <>
    <div className="metric-grid">{[
      ['Tracked images', stats.retention.total.toLocaleString(), 'Across your entire library', 'images'],
      ['Requests', stats.totals.requests.toLocaleString(), `${stats.totals.upload_requests.toLocaleString()} upload attempts`, 'arrow'],
      ['Total traffic', formatBytes(stats.totals.bytes), 'Uploaded and downloaded', 'overview'],
      ['Active IPs', stats.totals.ips.toLocaleString(), 'Unique addresses in this period', 'ips'],
    ].map(([label, number, note, icon]) => <div className="metric" key={label}><div className="metric-label">{label}<Icon name={icon as 'images' | 'arrow' | 'overview' | 'ips'} size={17} /></div><strong>{number}</strong><span>{note}</span></div>)}</div>
    <ActivityChart stats={stats} />
    <div className="overview-bottom"><RetentionChart stats={stats.retention} onExplore={onExplore} /><section className="panel"><div className="panel-heading"><div><h2>Top addresses</h2><p>Where your activity comes from</p></div><AdminSelect aria-label="Rank IPs by" className="small-select" disabled={busy} value={order} onChange={event => onOrderChange(event.target.value as 'traffic' | 'uploads')}><option value="traffic">By traffic</option><option value="uploads">By uploads</option></AdminSelect></div>
      <div className="ip-rankings">{stats.ips.map((row, index) => <div className="ip-ranking" key={row.ip}><span className="ranking-index">{String(index + 1).padStart(2, '0')}</span><div className="ranking-info"><div className="ranking-title"><span className="mono">{row.ip}</span><strong>{order === 'traffic' ? formatBytes(row.bytes) : `${row.upload_requests} uploads`}</strong></div><IpLocation ip={row} /><div className="ranking-bar"><span style={{ width: `${Math.max(1, value(row) / peak * 100)}%` }} /></div><span className="muted small">{row.requests} requests · {row.failed_requests} failed · {row.successful_uploads} successful uploads</span></div></div>)}{!stats.ips.length && <div className="compact-empty"><Icon name="ips" size={25} /><h3>No activity yet</h3><p>Addresses will appear as traffic arrives.</p></div>}</div>
    </section></div>
  </>;
}
