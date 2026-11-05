import { Alert } from '@mui/material';
import { useEffect, useState } from 'react';
import { MEBIBYTE, type UploadLimits } from '../../uploadLimits';
import { jsonBody, type Api, type Run } from './model';
import { AdminButton, AdminInput, Icon } from './ui';

function formatMiB(bytes: number): string {
  return String(Number((bytes / MEBIBYTE).toFixed(6)));
}

function sameLimits(left: UploadLimits, right: UploadLimits): boolean {
  return left.maxImageDimension === right.maxImageDimension && left.maxUploadBytes === right.maxUploadBytes;
}

export default function UploadSettings({
  api,
  run,
  busy,
  limits,
  onLimits,
}: {
  api: Api;
  run: Run;
  busy: boolean;
  limits: UploadLimits;
  onLimits: (limits: UploadLimits) => void;
}) {
  const [maxImageDimension, setMaxImageDimension] = useState(limits.maxImageDimension === null ? '' : String(limits.maxImageDimension));
  const [dimensionUnlimited, setDimensionUnlimited] = useState(limits.maxImageDimension === null);
  const [maxUploadMiB, setMaxUploadMiB] = useState(limits.maxUploadBytes === null ? '' : formatMiB(limits.maxUploadBytes));
  const [uploadUnlimited, setUploadUnlimited] = useState(limits.maxUploadBytes === null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setMaxImageDimension(limits.maxImageDimension === null ? '' : String(limits.maxImageDimension));
    setDimensionUnlimited(limits.maxImageDimension === null);
    setMaxUploadMiB(limits.maxUploadBytes === null ? '' : formatMiB(limits.maxUploadBytes));
    setUploadUnlimited(limits.maxUploadBytes === null);
  }, [limits.maxImageDimension, limits.maxUploadBytes]);

  function changed(update: () => void) {
    update();
    setError('');
    setSaved(false);
  }

  function applyLimits(next: UploadLimits) {
    setMaxImageDimension(next.maxImageDimension === null ? '' : String(next.maxImageDimension));
    setDimensionUnlimited(next.maxImageDimension === null);
    setMaxUploadMiB(next.maxUploadBytes === null ? '' : formatMiB(next.maxUploadBytes));
    setUploadUnlimited(next.maxUploadBytes === null);
    onLimits(next);
  }

  function draftUploadBytes(): number | null {
    if (uploadUnlimited) return null;
    if (limits.maxUploadBytes !== null && maxUploadMiB === formatMiB(limits.maxUploadBytes)) return limits.maxUploadBytes;
    return Math.round(Number(maxUploadMiB) * MEBIBYTE);
  }

  async function save() {
    setError('');
    setSaved(false);
    const dimension = dimensionUnlimited ? null : Number(maxImageDimension);
    if (dimension !== null && (!/^\d+$/.test(maxImageDimension) || !Number.isSafeInteger(dimension) || dimension <= 0)) {
      setError('Maximum image edge must be a positive whole number, or choose No limit.');
      return;
    }
    const uploadBytes = draftUploadBytes();
    if (uploadBytes !== null && (!maxUploadMiB.trim() || !Number.isFinite(Number(maxUploadMiB)) || !Number.isSafeInteger(uploadBytes) || uploadBytes <= 0)) {
      setError('Maximum upload size must be a positive number of MiB, or choose No limit.');
      return;
    }
    const next = { maxImageDimension: dimension, maxUploadBytes: uploadBytes };
    const success = await run(async () => {
      const response = await api<UploadLimits>('/upload-settings', jsonBody(next, 'PATCH'));
      applyLimits(response);
      setSaved(true);
    });
    if (!success) setSaved(false);
  }

  return <section className="settings-section">
    <div className="settings-description">
      <span className="eyebrow">UPLOAD LIMITS</span>
      <h2>Control image size</h2>
      <p>Set image dimensions and upload size independently. Each limit can be disabled without changing the other.</p>
    </div>
    <div className="panel settings-card">
      <h3>Image limits</h3>
      <div className="limit-grid">
        <div className="limit-field">
          <strong>Maximum image edge</strong>
          <div className="limit-control">
            <AdminInput
              aria-label="Maximum image edge in pixels"
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              value={maxImageDimension}
              disabled={busy || dimensionUnlimited}
              onChange={event => changed(() => setMaxImageDimension(event.target.value))}
            />
            <span className="limit-unit">px</span>
          </div>
          <label className="check-field compact">
            <AdminInput type="checkbox" checked={dimensionUnlimited} disabled={busy} onChange={event => changed(() => setDimensionUnlimited(event.target.checked))} />
            <span>No limit</span>
          </label>
          <p className="field-help">The longest edge is scaled down before upload. No limit retains the original dimensions.</p>
        </div>
        <div className="limit-field">
          <strong>Maximum upload size</strong>
          <div className="limit-control">
            <AdminInput
              aria-label="Maximum upload size in MiB"
              type="number"
              min="0.000001"
              step="any"
              inputMode="decimal"
              value={maxUploadMiB}
              disabled={busy || uploadUnlimited}
              onChange={event => changed(() => setMaxUploadMiB(event.target.value))}
            />
            <span className="limit-unit">MiB</span>
          </div>
          <label className="check-field compact">
            <AdminInput type="checkbox" checked={uploadUnlimited} disabled={busy} onChange={event => changed(() => setUploadUnlimited(event.target.checked))} />
            <span>No limit</span>
          </label>
          <p className="field-help">Measured across the encoded upload body. Cloudflare request limits still apply when this is disabled.</p>
        </div>
      </div>
      {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
      {saved && <Alert severity="success" sx={{ mt: 2 }}>Upload limits saved.</Alert>}
      <AdminButton className="button primary" disabled={busy || sameLimits({ maxImageDimension: dimensionUnlimited ? null : Number(maxImageDimension), maxUploadBytes: draftUploadBytes() }, limits)} onClick={() => void save()}>
        Save limits<Icon name="check" size={16} />
      </AdminButton>
    </div>
  </section>;
}
