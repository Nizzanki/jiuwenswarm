import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryRecord, TurnSummary } from '../../stores/traceHoundStore';
import { C, cat } from './traceTokens';
import { useElementWidth } from './useElementWidth';
import { agentColor, isFailedToolResult, recordHeaderLabel } from './recordMeta';
import { timelineLanes, timelineLaneOf, type TimelineLane } from './traceTimeline';
import { Tooltip } from './Tooltip';

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

const LABEL_W = 84;
const LANE_H = 22;

function fmtClock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function laneDisplay(l: TimelineLane, t: ReturnType<typeof useTranslation>['t']): string {
  switch (l.role) {
    case 'user': return t('traceHound.timeline.user');
    case 'leader': return `⛨ ${t('traceHound.perAgent.leader')}`;
    case 'agent': return t('traceHound.timeline.agent');
    default: return l.key.length > 16 ? `${l.key.slice(0, 15)}…` : l.key;
  }
}

/** Per-agent swimlane timeline of one turn's records. Time runs left→right on a
 *  shared axis; each agent gets its own horizontal lane so multi-agent turns
 *  read as a conversation. Single-agent turns collapse to user + one agent
 *  lane. Dots are token-colored, red-ringed on failures, and their tooltip
 *  mirrors the matching record card's header exactly. */
export function TimelineBand({
  records,
  onClickRecord,
}: {
  records: HistoryRecord[];
  onClickRecord?: (r: HistoryRecord, index: number) => void;
}) {
  const { t } = useTranslation();
  const [wrapRef, wrapW] = useElementWidth<HTMLDivElement>();
  const lanes = useMemo(() => timelineLanes(records), [records]);
  const pts = records.filter(r => (r.timestamp ?? 0) > 0);
  if (pts.length === 0) return null;
  const t0 = Math.min(...pts.map(r => r.timestamp!));
  const t1 = Math.max(...pts.map(r => r.timestamp!));
  const span = Math.max(t1 - t0, 0.001);
  // Floor so ultra-narrow panes don't squeeze dots together (scrolls instead).
  const W = Math.max(Math.round(wrapW), 320);
  const plotW = Math.max(W - LABEL_W - 12, 120);
  const H = lanes.length * LANE_H;
  const laneY = (i: number) => i * LANE_H + LANE_H / 2;
  const x = (ts: number) => LABEL_W + ((ts - t0) / span) * plotW + 6;
  return (
    <div ref={wrapRef} style={{ marginBottom: 10 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img">
        {lanes.map((l, i) => {
          const y = laneY(i);
          const labelColor = l.role === 'user' || l.role === 'agent' ? C.textMuted : agentColor(l.key);
          return (
            <g key={l.key}>
              <line x1={LABEL_W} y1={y} x2={W} y2={y} stroke={C.border} strokeWidth={1} />
              <text x={0} y={y + 3} fontSize={10} fontWeight={600} fill={labelColor}>
                {laneDisplay(l, t)}
              </text>
            </g>
          );
        })}
        {records.map((r, i) => {
          if ((r.timestamp ?? 0) <= 0) return null;
          const lane = timelineLaneOf(r, lanes);
          const cx = x(r.timestamp!);
          const cy = laneY(lane);
          const et = r.role === 'user' ? 'user' : (r.event_type ?? '');
          const color = EVENT_COLORS[et] ?? C.textFaint;
          const failed = isFailedToolResult(r);
          const title = `${recordHeaderLabel(r, t)}\n${fmtClock(r.timestamp!)} · +${(r.timestamp! - t0).toFixed(1)}s${failed ? ` ${t('traceHound.graph.failed')}` : ''}`;
          return (
            <Tooltip key={i} text={title}>
              <g style={{ cursor: onClickRecord ? 'pointer' : 'default' }} onClick={() => onClickRecord?.(r, i)}>
                {/* generous invisible hit target keeps dots clickable */}
                <circle cx={cx} cy={cy} r={9} fill="transparent" />
                <circle cx={cx} cy={cy} r={failed ? 6 : 5} fill={failed ? C.danger : color} opacity={0.9} pointerEvents="none" />
              </g>
            </Tooltip>
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
