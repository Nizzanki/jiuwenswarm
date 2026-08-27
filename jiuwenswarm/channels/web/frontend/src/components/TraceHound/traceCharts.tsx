import { useTranslation } from 'react-i18next';
import type { HistoryRecord, TurnSummary } from '../../stores/traceHoundStore';
import { C, cat } from './traceTokens';
import { useElementWidth } from './useElementWidth';

export const EVENT_COLORS: Record<string, string> = {
  user: C.info,
  'chat.reasoning': C.violet,
  'chat.tool_call': C.warn,
  'chat.tool_result': C.ok,
  'chat.final': C.info,
  'chat.file': C.teal,
  'chat.usage_metadata': C.violet,
  'chat.error': C.danger,
};

/** Horizontal wall-clock strip of one turn's records (SVG, token-colored).
 *  The viewBox width tracks the container's measured pixel width so one SVG
 *  unit stays one CSS px at any pane size (no shrink-to-fit miniaturization). */
export function TimelineBand({
  records,
  height = 48,
  onClickRecord,
}: {
  records: HistoryRecord[];
  height?: number;
  onClickRecord?: (r: HistoryRecord) => void;
}) {
  const { t } = useTranslation();
  const [wrapRef, wrapW] = useElementWidth<HTMLDivElement>();
  const pts = records.filter(r => (r.timestamp ?? 0) > 0);
  if (pts.length === 0) return null;
  const t0 = Math.min(...pts.map(r => r.timestamp!));
  const t1 = Math.max(...pts.map(r => r.timestamp!));
  const span = Math.max(t1 - t0, 0.001);
  // Floor so ultra-narrow panes don't squeeze dots together (scrolls instead).
  const W = Math.max(Math.round(wrapW), 320);
  const cy = height / 2;
  return (
    <div ref={wrapRef}>
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" height={height} role="img">
        <line x1={0} y1={cy} x2={W} y2={cy} stroke={C.border} strokeWidth={1} />
        {pts.map((r, i) => {
          const x = ((r.timestamp! - t0) / span) * (W - 12) + 6;
          const et = r.role === 'user' ? 'user' : (r.event_type ?? '');
          const color = EVENT_COLORS[et] ?? C.textFaint;
          const failed = r.event_type === 'chat.tool_result' && (r.result ?? '').includes('success=False');
          const title = `${et} @ +${(r.timestamp! - t0).toFixed(1)}s${failed ? ` ${t('traceHound.graph.failed')}` : ''}`;
          return (
            <g key={i} style={{ cursor: onClickRecord ? 'pointer' : 'default' }} onClick={() => onClickRecord?.(r)}>
              {/* generous invisible hit target keeps dots clickable */}
              <circle cx={x} cy={cy} r={9} fill="transparent">
                <title>{title}</title>
              </circle>
              <circle cx={x} cy={cy} r={failed ? 6 : 5} fill={failed ? C.danger : color} opacity={0.9} pointerEvents="none" />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Team-mode per-agent activity bars (tool calls / failures / LLM calls / tokens). */
export function PerAgentCard({ turn, onAgentClick }: { turn: TurnSummary; onAgentClick?: (name: string) => void }) {
  const { t } = useTranslation();
  const acts = turn.agent_activity ?? [];
  if (acts.length === 0) return null;
  const maxVal = Math.max(...acts.flatMap(a => [a.tool_calls, a.tool_failures, a.llm_calls, Math.ceil(a.tokens / 1000)]), 1);
  return (
    <div data-testid="tracehound-per-agent" style={{ background: C.surface, borderRadius: 6, padding: 12, border: `1px solid ${C.border}` }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t('traceHound.perAgent.title')}</div>
      {acts.map((a, i) => (
        <div key={a.name} style={{ marginBottom: 8, cursor: onAgentClick ? 'pointer' : 'default' }} onClick={() => onAgentClick?.(a.name)}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
            <span style={{ color: cat(i + 1) }}>
              {a.role === 'leader' ? '⛨ ' : ''}
              {a.name}
            </span>
            <span style={{ color: C.textMuted }}>{a.llm_calls > 0 ? t('traceHound.perAgent.llmTokens', { llm: a.llm_calls, tokens: a.tokens.toLocaleString() }) : t('traceHound.perAgent.noUsage')}</span>
          </div>
          {(
            [
              ['tools', a.tool_calls, C.warn],
              ['fails', a.tool_failures, C.danger],
              ['llm', a.llm_calls, C.violet],
            ] as const
          ).map(([label, v, color]) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <span style={{ fontSize: 9, color: C.textFaint, width: 32 }}>{t(`traceHound.perAgent.${label}`)}</span>
              <div style={{ flex: 1, height: 4, background: C.surfaceMuted, borderRadius: 2 }}>
                <div style={{ height: 4, width: `${(v / maxVal) * 100}%`, background: color, borderRadius: 2 }} />
              </div>
              <span style={{ fontSize: 9, color: C.textMuted, width: 24, textAlign: 'right' }}>{v}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
