import { Alert } from '@mui/material';
import { AdminButton, AdminInput, AdminSelect, AdminBadge } from './ui';
import { useEffect, useState } from 'react';
import { cleanupLabel, dateLabel, emptyFilters, expiries, filterError, filterTags, lifecycles, removeFilter, sourceLabel, sources, statusLabel, statuses, type Filters, type ImageRow } from './model';
import { Drawer, EmptyState, Evidence, Icon } from './ui';

interface Props {
  images: ImageRow[]; filters: Filters; busy: boolean; cursor: string | null; retentionMs: number;
  onApply: (filters: Filters) => void; onMore: () => void;
  onAction: (image: ImageRow, action: 'approve' | 'remove' | 'lock') => Promise<boolean>;
}
export default function ImageLibrary({ images, filters, busy, cursor, retentionMs, onApply, onMore, onAction }: Props) {
  const [draft, setDraft] = useState(filters);
  const [filterOpen, setFilterOpen] = useState(false);
  const [selected, setSelected] = useState<ImageRow | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  useEffect(() => setDraft(filters), [filters]);
  const tags = filterTags(filters);
  const validation = filterError(draft);
  const update = (field: keyof Filters, value: string) => setDraft(previous => {
    const next = { ...previous, [field]: value };
    if (field === 'retention' && value !== 'unlocked') return { ...next, expiry: '', minDays: '', maxDays: '' };
    if (field === 'expiry' && value) next.retention = 'unlocked';
    return next;
  });
  async function action(value: 'approve' | 'remove' | 'lock') {
    if (!selected) return;
    if (await onAction(selected, value)) { setSelected(null); setConfirmRemove(false); }
  }
  return <>
    <div className="library-toolbar">
      <form className="search-box" onSubmit={event => { event.preventDefault(); onApply({ ...filters, search: draft.search.trim() }); }}>
        <Icon name="search" /><AdminInput aria-label="Search image ID or exact uploader IP" placeholder="Search image ID or uploader IP…" value={draft.search} maxLength={64} onChange={event => update('search', event.target.value)} /><AdminButton type="submit" disabled={busy}>Search</AdminButton>
      </form>
      <AdminButton className={`button ${tags.length ? 'has-filters' : ''}`} disabled={busy} onClick={() => { setDraft({ ...filters, search: draft.search }); setFilterOpen(true); }}><Icon name="filter" />Filters{tags.length > 0 && <span className="count-pill">{tags.length}</span>}</AdminButton>
    </div>
    <div className="library-subbar"><div className="view-presets" aria-label="Image views">
      <AdminButton disabled={busy} className={!tags.length ? 'active' : ''} onClick={() => onApply(emptyFilters)}>All images</AdminButton>
      <AdminButton disabled={busy} className={filters.status === 'error' ? 'active' : ''} onClick={() => onApply({ ...emptyFilters, status: 'error' })}>Needs review</AdminButton>
      <AdminButton disabled={busy} className={filters.retention === 'locked' ? 'active' : ''} onClick={() => onApply({ ...emptyFilters, retention: 'locked' })}>Locked</AdminButton>
    </div><div className="segmented compact" aria-label="Image layout"><AdminButton aria-pressed={view === 'grid'} className={view === 'grid' ? 'selected' : ''} onClick={() => setView('grid')}><Icon name="overview" size={16} /> Grid</AdminButton><AdminButton aria-pressed={view === 'list'} className={view === 'list' ? 'selected' : ''} onClick={() => setView('list')}><Icon name="audit" size={16} /> List</AdminButton></div></div>
    {tags.length > 0 && <div className="filter-tags" aria-label="Applied filters"><span className="muted">Matching all</span>{tags.map(tag => <AdminButton key={tag.field} disabled={busy} onClick={() => onApply(removeFilter(filters, tag.field))}>{tag.label}<Icon name="close" size={13} /></AdminButton>)}<AdminButton className="clear-filters" disabled={busy} onClick={() => onApply(emptyFilters)}>Clear all</AdminButton></div>}
    <div className="results-heading"><span>{images.length.toLocaleString()} {cursor ? 'loaded' : 'images'}{tags.length ? ' matching your filters' : ' in your library'}</span><span>Sorted by image ID</span></div>
    {!images.length ? <div className="panel"><EmptyState title={busy ? 'Loading your library…' : tags.length ? 'No images match these filters' : 'Your library starts here'} action={tags.length ? <AdminButton className="button" disabled={busy} onClick={() => onApply(emptyFilters)}>Clear filters</AdminButton> : undefined}>{tags.length ? 'Try a wider day range or remove a condition.' : 'Uploaded images will appear here, ready to review and manage.'}</EmptyState></div> : <div className={view === 'grid' ? 'image-grid' : 'image-list'}>
      {images.map(image => <AdminButton key={image.image_id} className="image-card" onClick={() => { setSelected(image); setConfirmRemove(false); }}>
        <div className="image-preview"><img src={`/${image.image_id}?search`} alt={`Preview of ${image.image_id}`} loading="lazy" onError={event => { event.currentTarget.style.visibility = 'hidden'; }} /><span className="preview-placeholder"><Icon name="images" size={26} /></span>{!!image.locked && <span className="image-lock" title="Locked"><Icon name="lock" size={14} /></span>}</div>
        <div className="image-card-info"><div className="image-card-title"><span className="mono" title={image.image_id}>{image.image_id.slice(0, 10)}…{image.image_id.slice(-4)}</span><Icon name="chevron" size={14} /></div><AdminBadge className={`badge ${image.moderation_status}`}>{statusLabel(image.moderation_status)}</AdminBadge><div className="image-card-footer"><span className={image.locked ? 'text-accent' : ''}>{cleanupLabel(image, retentionMs)}</span><span title="Last access">{new Date(image.last_accessed_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></div></div>
      </AdminButton>)}
    </div>}
    {cursor && <div className="load-more"><AdminButton className="button" disabled={busy} onClick={onMore}>{busy ? 'Loading…' : 'Load more images'}<Icon name="arrow" size={16} /></AdminButton></div>}
    {filterOpen && <Drawer title="Filter images" onClose={() => setFilterOpen(false)}><form className="filter-form" onSubmit={event => { event.preventDefault(); if (validation) return; onApply({ ...draft, search: draft.search.trim() }); setFilterOpen(false); }}>
      <div className="drawer-body"><p className="muted">Narrow your library. Every selected condition must match.</p>
        <section className="filter-section"><h3><span>01</span>Review</h3><label className="field">Review status<AdminSelect aria-label="Review status" value={draft.status} onChange={event => update('status', event.target.value)}>{statuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</AdminSelect></label><label className="field">Approval source<AdminSelect aria-label="Approval source" value={draft.source} onChange={event => update('source', event.target.value)}>{sources.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</AdminSelect></label></section>
        <section className="filter-section"><h3><span>02</span>Retention</h3><label className="field">Storage policy<AdminSelect aria-label="Storage policy" value={draft.retention} onChange={event => update('retention', event.target.value)}>{lifecycles.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</AdminSelect></label><label className="field">Time until cleanup<AdminSelect aria-label="Time until cleanup" value={draft.expiry} disabled={draft.retention === 'locked' || draft.retention === 'deleting'} onChange={event => update('expiry', event.target.value)}>{expiries.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</AdminSelect></label>
          {draft.expiry === 'custom' && <div className="range-fields"><label className="field">From<AdminInput type="number" min="0" max="1000000" step="1" placeholder="0" value={draft.minDays} onChange={event => update('minDays', event.target.value)} /></label><span>to</span><label className="field">Through<AdminInput type="number" min="0" max="1000000" step="1" placeholder="No limit" value={draft.maxDays} onChange={event => update('maxDays', event.target.value)} /></label><span>days</span></div>}
          <p className="field-help">{draft.retention === 'locked' ? 'Locked images stay in storage until you unlock them.' : draft.retention === 'deleting' ? 'These images have already entered the deletion process.' : 'Days round up. Day 0 includes images already due. Choosing a time range selects images scheduled for cleanup.'}</p>
        </section>
        <section className="filter-section"><h3><span>03</span>Find an image</h3><label className="field">Image ID or exact uploader IP<AdminInput value={draft.search} maxLength={64} placeholder="Partial ID or full IP address" onChange={event => update('search', event.target.value)} /></label></section>
        {validation && <Alert severity="error">{validation}</Alert>}
      </div><footer className="drawer-footer"><AdminButton type="button" className="button subtle" onClick={() => setDraft(emptyFilters)}>Reset</AdminButton><AdminButton type="submit" className="button primary" disabled={busy || !!validation}>Apply filters<Icon name="arrow" size={16} /></AdminButton></footer>
    </form></Drawer>}
    {selected && <Drawer title="Image details" onClose={() => { if (!busy) setSelected(null); }}><div className="drawer-body image-details"><div className="detail-preview"><img src={`/${selected.image_id}?search`} alt="Selected image" /></div><div className="detail-title"><AdminBadge className={`badge ${selected.moderation_status}`}>{statusLabel(selected.moderation_status)}</AdminBadge><a className="text-link" href={`/${selected.image_id}?search`} target="_blank" rel="noopener">Open original ↗</a></div><p className="mono full-id">{selected.image_id}</p><dl className="detail-facts">{[['Retention', cleanupLabel(selected, retentionMs)], ['Approval source', sourceLabel(selected.moderation_reason)], ['Uploader IP', selected.uploader_ip ?? 'Unknown'], ['Uploaded', dateLabel(selected.uploaded_at)], ['Last accessed', dateLabel(selected.last_accessed_at)], ['Reviewed', dateLabel(selected.moderated_at)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><Evidence error={selected.moderation_error} response={selected.moderation_response} />
      <section className="detail-actions"><h3>Manage this image</h3><p className="muted">{selected.locked ? 'Unlock to resume cleanup based on the last access time.' : 'Lock to keep this image indefinitely.'}</p><div className="button-row"><AdminButton className="button" disabled={busy || !!selected.deleting} onClick={() => void action('lock')}><Icon name="lock" size={16} />{selected.locked ? 'Unlock image' : 'Lock image'}</AdminButton><AdminButton className="button primary" disabled={busy || !!selected.deleting || selected.moderation_reason === 'manual_approved'} onClick={() => void action('approve')}><Icon name="check" size={16} />Approve</AdminButton></div></section>
      <section className="danger-zone"><h3>Remove image</h3><p className="muted">{selected.locked ? 'Unlock this image before removing it.' : 'Remove the file from server storage. Cached copies and Git history may remain.'}</p>{confirmRemove ? <Alert severity="warning"><p>Remove this image permanently from storage?</p><div className="button-row"><AdminButton className="button danger-button" disabled={busy || !!selected.locked || !!selected.deleting} onClick={() => void action('remove')}>Confirm removal</AdminButton><AdminButton className="button" disabled={busy} onClick={() => setConfirmRemove(false)}>Cancel</AdminButton></div></Alert> : <AdminButton className="button danger-button" disabled={busy || !!selected.locked || !!selected.deleting} onClick={() => setConfirmRemove(true)}>Remove image…</AdminButton>}</section>
    </div></Drawer>}
  </>;
}
