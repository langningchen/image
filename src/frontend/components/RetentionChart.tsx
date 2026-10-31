import { AdminButton, AdminBadge } from '../admin/ui';
import { useState } from 'react';
import type { Filters } from '../admin/model';
import { retentionBucketFilters } from '../admin/model';

export interface RetentionStats { buckets: { bucket: string; count: number }[]; total: number; generatedAt: number; retentionMs: number }
const segments = [
  { bucket: 'due', label: 'Ready for cleanup', color: '#d32f2f' },
  ...Array.from({ length: 6 }, (_, index) => ({ bucket: String(index + 1), label: index === 0 ? 'Within 1 day' : `${index + 1} days`, color: ['#ef6c00', '#f9a825', '#c0ca33', '#7cb342', '#00897b', '#00acc1'][index] })),
  { bucket: '7-14', label: '7–14 days', color: '#1976d2' },
  { bucket: '15-21', label: '15–21 days', color: '#3949ab' },
  { bucket: '22-30', label: '22–30 days', color: '#5e35b1' },
  { bucket: 'over30', label: 'More than 30 days', color: '#8e24aa' },
  { bucket: 'locked', label: 'Locked', color: '#7b1fa2' },
  { bucket: 'deleting', label: 'Deleting', color: '#757575' },
];
export default function RetentionChart({ stats, onExplore }: { stats: RetentionStats; onExplore: (filters: Filters) => void }) {
  const [active, setActive] = useState<string | null>(null);
  const rows = segments.map(segment => ({ ...segment, count: stats.buckets.find(row => row.bucket === segment.bucket)?.count ?? 0 }));
  const selected = rows.find(row => row.bucket === active);
  const circumference = 2 * Math.PI * 74;
  let offset = 0;
  function explore(bucket: string) {
    onExplore(retentionBucketFilters(bucket));
  }
  return <section className="panel retention-panel"><div className="panel-heading"><div><h2>Retention outlook</h2><p>When images become eligible for cleanup</p></div><AdminBadge className="badge neutral">All images</AdminBadge></div><div className="retention-content">
    <div className="donut-wrap"><svg width="220" height="220" viewBox="0 0 220 220" role="img" aria-label="Image cleanup distribution"><circle cx="110" cy="110" r="74" stroke="#eee" strokeWidth="22" fill="none" />{rows.filter(row => row.count).map(row => {
      const length = row.count / stats.total * circumference;
      const start = offset; offset += length;
      return <circle key={row.bucket} cx="110" cy="110" r="74" fill="none" stroke={row.color} strokeWidth={active === row.bucket ? 27 : 22} strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={-start} transform="rotate(-90 110 110)" opacity={active && active !== row.bucket ? .25 : 1} onMouseEnter={() => setActive(row.bucket)} onMouseLeave={() => setActive(null)}><title>{row.label}: {row.count}</title></circle>;
    })}<text x="110" y="110" textAnchor="middle" className="donut-value">{(selected?.count ?? stats.total).toLocaleString()}</text><text x="110" y="133" textAnchor="middle" className="donut-label">{selected?.label ?? 'tracked images'}</text></svg><p className="muted">Select a group to explore images</p></div>
    <div className="retention-legend">{rows.map(row => <AdminButton key={row.bucket} disabled={!row.count} onClick={() => explore(row.bucket)} onMouseEnter={() => setActive(row.bucket)} onMouseLeave={() => setActive(null)} onFocus={() => setActive(row.bucket)} onBlur={() => setActive(null)}><span className="legend-dot" style={{ background: row.color }} /><span>{row.label}</span><strong>{row.count.toLocaleString()}</strong><span className="legend-percent">{stats.total ? Math.round(row.count / stats.total * 100) : 0}%</span></AdminButton>)}</div>
  </div><div className="panel-note">Based on last access. Actual deletion runs during daily cleanup.</div></section>;
}
