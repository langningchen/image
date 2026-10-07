import { useState } from 'react';
import { Box, Button, Checkbox, FormControlLabel, Link, Typography } from '@mui/material';
import { TERMS_VERSION, LLAMA_LICENSE_URL, LLAMA_POLICY_URL } from '../../terms.ts';

export default function UploadConsent({ onAccept }: { onAccept: () => void }) {
  const [terms, setTerms] = useState(false);
  const [eligible, setEligible] = useState(false);
  return <Box sx={{ mb: 3 }}>
    <Typography variant="h6">Before uploading</Typography>
    <Typography variant="body2">Images are publicly accessible by URL and may be sent to Cloudflare Workers AI for content assessment. Do not upload private or sensitive information. Built with Llama.</Typography>
    <FormControlLabel control={<Checkbox checked={terms} onChange={event => setTerms(event.target.checked)} />} label={<span>I have read and agree to the <Link href="/terms.html" target="_blank" rel="noopener">Terms of Service</Link> ({TERMS_VERSION}), the <Link href={LLAMA_LICENSE_URL} target="_blank" rel="noopener">Llama 3.2 Community License</Link>, and the <Link href={LLAMA_POLICY_URL} target="_blank" rel="noopener">Acceptable Use Policy</Link>.</span>} />
    <FormControlLabel control={<Checkbox checked={eligible} onChange={event => setEligible(event.target.checked)} />} label="I am not an individual domiciled in, or acting for a company with its principal place of business in, the European Union, and I have authority to accept these terms." />
    <Button variant="contained" disabled={!terms || !eligible} onClick={onAccept}>Agree and continue</Button>
  </Box>;
}
