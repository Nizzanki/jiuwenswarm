/**
 * TraceHound palette: role-named CSS-variable tokens.
 * Components use C.* in inline styles; concrete values live only in light.css.
 */
export const C = {
  ok: 'var(--color-trace-ok)',
  okSubtle: 'var(--color-trace-ok-subtle)',
  warn: 'var(--color-trace-warn)',
  warnSubtle: 'var(--color-trace-warn-subtle)',
  danger: 'var(--color-trace-danger)',
  dangerSubtle: 'var(--color-trace-danger-subtle)',
  violet: 'var(--color-trace-violet)',
  violetSubtle: 'var(--color-trace-violet-subtle)',
  info: 'var(--color-trace-info)',
  infoSubtle: 'var(--color-trace-info-subtle)',
  teal: 'var(--color-trace-teal)',
  surface: 'var(--color-trace-surface)',
  surfaceMuted: 'var(--color-trace-surface-muted)',
  border: 'var(--color-trace-border)',
  borderStrong: 'var(--color-trace-border-strong)',
  text: 'var(--color-trace-text)',
  textMuted: 'var(--color-trace-text-muted)',
  textFaint: 'var(--color-trace-text-faint)',
} as const;

/** Categorical color for agents/query types (1-based, cycles). */
export function cat(n: number): string {
  const i = ((Math.max(n, 1) - 1) % 6) + 1;
  return `var(--color-trace-cat-${i})`;
}
