import { Alert, Button } from '@mui/material';
import { AdminButton, AdminInput } from './ui';
import { useState } from 'react';
import { LLAMA_LICENSE_URL, LLAMA_POLICY_URL } from '../../terms';
import { prepareImage } from '../prepareImage';
import { jsonBody, type Api, type Run } from './model';
import { Evidence, Icon } from './ui';
import UploadSettings from './UploadSettings';
import type { UploadLimits } from '../../uploadLimits';

interface ModelTest {
  file: string; ok: boolean; verdict?: { approved: boolean; reason: string };
  responseType?: string; durationMs?: number; error?: string; modelResponse?: string;
}
export default function ModelSettings({ api, run, busy, fallback, onFallback, uploadLimits, onUploadLimits }: {
  api: Api; run: Run; busy: boolean; fallback: 'allow' | 'deny'; onFallback: (value: 'allow' | 'deny') => void;
  uploadLimits: UploadLimits; onUploadLimits: (limits: UploadLimits) => void;
}) {
  const [license, setLicense] = useState(false);
  const [eligible, setEligible] = useState(false);
  const [activated, setActivated] = useState(false);
  const [result, setResult] = useState<ModelTest | null>(null);
  const [policy, setPolicy] = useState(fallback);
  async function test(file: File) {
    setResult(null);
    await run(async () => {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('Could not read this image.'));
        reader.readAsDataURL(file);
      });
      const image = await prepareImage(dataUrl, uploadLimits.maxImageDimension);
      const response = await api<Omit<ModelTest, 'file'>>('/model-test', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: image }, true);
      setResult({ ...response, file: file.name });
    });
  }
  return <div className="settings-stack">
    <UploadSettings api={api} run={run} busy={busy} limits={uploadLimits} onLimits={onUploadLimits} />
    <section className="settings-section"><div className="settings-description"><span className="eyebrow">UPLOAD POLICY</span><h2>When AI is unavailable</h2><p>Choose what happens if assessment times out, fails, or returns an inconclusive answer.</p></div><div className="panel settings-card"><h3>Assessment fallback</h3><div className="policy-options">
      {(['allow', 'deny'] as const).map(value => <label className={`policy-option ${policy === value ? 'chosen' : ''}`} key={value}><AdminInput type="radio" name="fallback" value={value} checked={policy === value} disabled={busy} onChange={() => setPolicy(value)} /><span><strong>{value === 'allow' ? 'Allow and queue for review' : 'Reject the upload'}</strong><small>{value === 'allow' ? 'Keep the image and flag it for a manual decision.' : 'Keep an audit record without storing the image.'}</small></span></label>)}
    </div><p className="field-help">Explicitly prohibited content is always rejected. A policy managed by the environment cannot be changed here.</p><AdminButton className="button primary" disabled={busy || policy === fallback} onClick={() => void run(async () => { const response = await api<{ fallback: 'allow' | 'deny' }>('/moderation-settings', jsonBody({ fallback: policy }, 'PATCH')); onFallback(response.fallback); })}>Save policy</AdminButton></div></section>
    <section className="settings-section"><div className="settings-description"><span className="eyebrow">MODEL ACTIVATION</span><h2>Connect image assessment</h2><p>The Cloudflare account operator must accept the model license before the first assessed upload.</p></div><div className="panel settings-card"><h3>Llama 3.2 Vision</h3><p className="muted">Your acceptance applies to the Cloudflare account. Consent from people uploading images is separate.</p><label className="check-field"><AdminInput type="checkbox" checked={license} disabled={busy} onChange={event => setLicense(event.target.checked)} /><span>As the authorized operator, I accept the <a href={LLAMA_LICENSE_URL} target="_blank" rel="noopener">Community License</a> and <a href={LLAMA_POLICY_URL} target="_blank" rel="noopener">Acceptable Use Policy</a>.</span></label><label className="check-field"><AdminInput type="checkbox" checked={eligible} disabled={busy} onChange={event => setEligible(event.target.checked)} /><span>The operator is not an individual domiciled in, or a company principally based in, the European Union.</span></label><AdminButton className="button" disabled={busy || !license || !eligible} onClick={() => void run(async () => { setActivated(false); await api('/model-license', jsonBody({ agree: true, nonEuOperator: true })); setActivated(true); })}>Agree and activate<Icon name="arrow" size={16} /></AdminButton>{activated && <Alert severity="success" sx={{ mt: 2 }}>Cloudflare accepted the activation request.</Alert>}</div></section>
    <section className="settings-section"><div className="settings-description"><span className="eyebrow">DIAGNOSTICS</span><h2>Try an assessment</h2><p>Check a verdict, response format and timing before relying on the model.</p></div><div className="panel settings-card"><h3>Test an image</h3><p className="muted">This test does not store the image, record violations, or apply the fallback policy.</p><Button variant="outlined" component="label" disabled={busy}><Icon name="images" size={18} />Choose test image<AdminInput className="visually-hidden" disabled={busy} type="file" accept="image/jpeg,image/png,image/webp" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void test(file); }} /></Button>{result && <div className="test-result"><p className="mono">{result.file}</p><Alert severity={!result.ok ? 'error' : result.verdict?.approved ? 'success' : 'warning'}>{result.ok ? `${result.verdict?.approved ? 'Allowed' : 'Rejected'} · ${result.verdict?.reason}` : `Assessment failed: ${result.error}`}</Alert>{result.ok && <p className="field-help">{result.responseType} response · {result.durationMs} ms</p>}<Evidence error={null} response={result.modelResponse ?? null} /></div>}</div></section>
  </div>;
}
