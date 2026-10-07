import { useState } from 'react';
import { Box, Card, CardContent, Typography } from '@mui/material';

export interface RetentionStats { buckets: { bucket: string; count: number }[]; total: number; generatedAt: number }
const segments = [
  { bucket: 'due', label: 'Ready for cleanup', color: '#d32f2f' },
  ...Array.from({ length: 7 }, (_, index) => ({ bucket: String(index + 1), label: index === 0 ? 'Within 1 day' : `${index + 1} days`, color: ['#ef6c00', '#f9a825', '#c0ca33', '#7cb342', '#00897b', '#00acc1', '#1976d2'][index] })),
  { bucket: 'locked', label: 'Locked', color: '#7b1fa2' },
  { bucket: 'deleting', label: 'Deleting', color: '#757575' },
];

export default function RetentionChart({ stats }: { stats: RetentionStats }) {
  const [active, setActive] = useState<string | null>(null);
  const rows = segments.map(segment => ({ ...segment, count: stats.buckets.find(row => row.bucket === segment.bucket)?.count ?? 0 }));
  const circumference = 2 * Math.PI * 70;
  let offset = 0;
  const selected = rows.find(row => row.bucket === active);
  return <Card variant="outlined" sx={{ minWidth: 0 }}><CardContent>
    <Typography variant="subtitle2" sx={{ mb: 1 }}>Time until image cleanup</Typography>
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 1.5 }}>
      <svg width="190" height="190" viewBox="0 0 190 190" role="img" aria-label="Image retention distribution" style={{ flexShrink: 0 }}>
        <circle cx="95" cy="95" r="70" stroke="#eee" strokeWidth="28" fill="none" />
        {rows.filter(row => row.count > 0).map(row => {
          const length = row.count / stats.total * circumference;
          const start = offset; offset += length;
          return <circle key={row.bucket} cx="95" cy="95" r="70" fill="none" stroke={row.color} strokeWidth="28"
            strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={-start} transform="rotate(-90 95 95)"
            opacity={active && active !== row.bucket ? .3 : 1} onMouseEnter={() => setActive(row.bucket)} onMouseLeave={() => setActive(null)}>
            <title>{row.label}: {row.count} ({(row.count / stats.total * 100).toFixed(1)}%)</title>
          </circle>;
        })}
        <text x="95" y="95" textAnchor="middle" fontSize="25" fontWeight="600" fill="#333">{(selected?.count ?? stats.total).toLocaleString('en-US')}</text>
        <text x="95" y="116" textAnchor="middle" fontSize="11" fill="#666">{selected?.label ?? 'Tracked images'}</text>
      </svg>
      <Box sx={{ flex: '1 1 160px', minWidth: 0 }}>
        {rows.map(row => <Box component="button" type="button" key={row.bucket} onMouseEnter={() => setActive(row.bucket)} onMouseLeave={() => setActive(null)} onFocus={() => setActive(row.bucket)} onBlur={() => setActive(null)}
          sx={{ border: 0, bgcolor: active === row.bucket ? 'grey.100' : 'transparent', display: 'flex', alignItems: 'center', width: '100%', p: .4, gap: .75, borderRadius: 1, cursor: 'pointer', textAlign: 'left' }}>
          <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: row.color, flexShrink: 0 }} />
          <Typography variant="caption" sx={{ flex: 1 }}>{row.label}</Typography>
          <Typography variant="caption">{row.count} · {stats.total ? Math.round(row.count / stats.total * 100) : 0}%</Typography>
        </Box>)}
      </Box>
    </Box>
    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>Based on last access. Eligible images are removed by the daily cleanup.</Typography>
  </CardContent></Card>;
}
