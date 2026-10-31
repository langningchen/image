import { type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';
import { Alert, Box, Button, ButtonBase, Checkbox, Chip, Drawer as MuiDrawer, IconButton, Radio, TextField, Typography } from '@mui/material';

export function AdminButton({ className = '', children, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'color'>) {
  const classes = className.split(' ');
  if (classes.includes('image-card')) return <ButtonBase {...props} className={className} sx={{ display: 'block', textAlign: 'left', width: '100%' }}>{children}</ButtonBase>;
  if (classes.includes('icon-button')) return <IconButton {...props} className={className} size="small">{children}</IconButton>;
  const variant = classes.includes('primary') || classes.includes('selected') ? 'contained' : classes.includes('button') && !classes.includes('subtle') ? 'outlined' : 'text';
  return <Button {...props} className={className} size="small" variant={variant} color={classes.includes('danger-button') || classes.includes('danger-text') ? 'error' : 'primary'} sx={{ gap: .75 }}>{children}</Button>;
}
export function AdminInput({ type, onChange, className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  if (type === 'file') return <input type="file" {...props} className={className} onChange={onChange} />;
  if (type === 'checkbox') return <Checkbox size="small" checked={props.checked} disabled={props.disabled} onChange={onChange} />;
  if (type === 'radio') return <Radio size="small" checked={props.checked} disabled={props.disabled} name={props.name} value={props.value} onChange={onChange} />;
  return <TextField size="small" fullWidth type={type} value={props.value} disabled={props.disabled} onChange={onChange} className={className} slotProps={{ htmlInput: props }} />;
}
export function AdminSelect({ children, onChange, className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <TextField select size="small" fullWidth className={className} value={props.value} disabled={props.disabled} onChange={event => onChange?.(event as unknown as React.ChangeEvent<HTMLSelectElement>)} slotProps={{ select: { native: true, inputProps: { 'aria-label': props['aria-label'] } } }}>{children}</TextField>;
}
export function AdminBadge({ className = '', children }: { className?: string; children: ReactNode }) {
  const color = /flagged/.test(className) ? 'error' : /error|pending/.test(className) ? 'warning' : 'default';
  return <Chip className={className} size="small" color={color} label={children} />;
}
const paths = {
  overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  images: 'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M3 16l5-5 5 5 3-3 5 5 M8 7h.01',
  audit: 'M6 3h12v18H6z M9 7h6 M9 11h6 M9 15h4',
  ips: 'M12 3v6 M5 15v-4h14v4 M2 15h6v6H2z M16 15h6v6h-6z M9 3h6v5H9z',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
  search: 'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15 M16 16l5 5',
  filter: 'M4 6h16 M7 12h10 M10 18h4',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M5 8a8 8 0 0 1 13-3l2 3 M4 16l2 3a8 8 0 0 0 13-3',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  close: 'M6 6l12 12 M6 18L18 6',
  lock: 'M7 10V7a5 5 0 0 1 10 0v3 M5 10h14v11H5z M12 14v3',
  logout: 'M10 3H4v18h6 M10 12h11 M17 8l4 4-4 4',
  check: 'M5 12l4 4L19 6',
  chevron: 'M9 5l7 7-7 7',
};
export function Icon({ name, size = 19 }: { name: keyof typeof paths; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <Box className="empty-state"><Typography variant="subtitle1">{title}</Typography><Typography variant="body2" color="text.secondary">{children}</Typography>{action}</Box>;
}
export function Evidence({ error, response }: { error: string | null; response: string | null }) {
  return <>{error && <Alert severity="error" sx={{ my: 1 }}>{error}</Alert>}{response && <Box component="details" sx={{ my: 1 }}><Typography component="summary" variant="caption" sx={{ cursor: 'pointer' }}>Model response (untrusted text)</Typography><Box component="pre" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 240, overflow: 'auto', fontSize: 11 }}>{response}</Box></Box>}</>;
}
export function Drawer({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return <MuiDrawer anchor="right" open onClose={onClose} slotProps={{ paper: { className: 'admin-ui drawer', role: 'dialog', 'aria-modal': true, 'aria-label': title, sx: { width: 480, maxWidth: '100%' } } }}><Box className="drawer-header"><Typography variant="h6">{title}</Typography><IconButton size="small" aria-label="Close details" onClick={onClose}><Icon name="close" /></IconButton></Box>{children}</MuiDrawer>;
}
