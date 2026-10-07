import { Typography } from '@mui/material';

export interface IpDetails {
  ip: string;
  country: string | null;
  region: string | null;
  city: string | null;
  asn: number | null;
  organization: string | null;
  upload_requests: number;
  successful_uploads: number;
  failed_uploads: number;
  uploads_today: number;
}

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
export default function IpLocation({ ip }: { ip: IpDetails }) {
  let country = ip.country;
  if (country && /^[A-Z]{2}$/.test(country)) country = countryNames.of(country) ?? country;
  const place = [...new Set([ip.city, ip.region, country].filter(Boolean))].join(', ');
  const network = [ip.asn === null ? null : `AS${ip.asn}`, ip.organization].filter(Boolean).join(' · ');
  return <Typography variant="caption" color="text.secondary" title={[place, network].filter(Boolean).join(' · ')} sx={{ display: 'block', overflowWrap: 'anywhere' }}>
    {place || 'Location unavailable'}{network ? ` · ${network}` : ''}
  </Typography>;
}
