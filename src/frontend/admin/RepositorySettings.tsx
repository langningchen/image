import { Alert } from '@mui/material';
import { useState } from 'react';
import { type Api, type Run } from './model';
import { AdminButton, Icon } from './ui';

export default function RepositorySettings({ api, run, busy }: { api: Api; run: Run; busy: boolean }) {
  const [result, setResult] = useState<{ changed: number; repository: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  async function sync() {
    setResult(null);
    setSyncing(true);
    try {
      await run(async () => {
        setResult(await api('/repository-config', { method: 'POST' }));
      });
    } finally {
      setSyncing(false);
    }
  }
  return <section className="settings-section">
    <div className="settings-description">
      <span className="eyebrow">DATA REPOSITORY</span>
      <h2>Daily history cleanup</h2>
      <p>Clean deleted images from Git history every day at 00:00 UTC (08:00 China time). Images still in the repository are preserved.</p>
    </div>
    <div className="panel settings-card">
      <h3>Sync repository configuration</h3>
      <p className="muted">Write or update the cleanup workflow and script together in the configured data repository. Files that are already up to date are skipped.</p>
      <p className="field-help">The GitHub token needs Contents and Workflows write access. Enable Actions and allow the cleanup workflow to force-push on the data repository’s default branch.</p>
      <AdminButton className="button primary" disabled={busy || syncing} onClick={() => void sync()}>
        <Icon name="refresh" size={16} />{syncing ? 'Syncing…' : 'Sync to data repository'}
      </AdminButton>
      {result && <Alert severity="success" sx={{ mt: 2 }}>
        {result.changed ? `Updated ${result.changed} configuration files in ${result.repository}.` : `${result.repository} is already up to date.`}
      </Alert>}
    </div>
  </section>;
}
