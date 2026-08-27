import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryRecord } from '../../stores/traceHoundStore';
import { C, cat } from './traceTokens';
import { buildGraph, type GraphNode, type GraphMode } from './traceGraph';

const LS_MODE = 'tracehound.graphMode';
const NODE_W = 48;
const NODE_H = 28;
const COL_W = 120;
const ROW_H = 64;
const KIND_STROKE: Record<GraphNode['kind'], string> = {
  user: C.text,
  agent: C.text,
  llm: C.violet,
  tool: C.warn,
  final: C.info,
};

/** Langfuse-style per-turn agent graph. Ranks nodes left-to-right in
 *  topological (record) order, groups them into member lanes, and pairs each
 *  tool call with the node following its result. */
export function TraceGraph({ records, onSelectRecord }: { records: HistoryRecord[]; onSelectRecord: (recordId: string) => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<GraphMode>(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem(LS_MODE) === 'expanded' ? 'expanded' : 'aggregated',
  );
  useEffect(() => {
    localStorage.setItem(LS_MODE, mode);
  }, [mode]);

  const g = useMemo(() => buildGraph(records, mode), [records, mode]);

  const { rankOf, laneOf, laneColor, laneCount } = useMemo(() => {
    // Ranks from the topological order of seq edges; nodes without a seq edge sit at rank 0.
    const indeg = new Map<string, number>();
    const adj = new Map<string, string[]>();
    for (const n of g.nodes) {
      indeg.set(n.id, 0);
      adj.set(n.id, []);
    }
    for (const e of g.edges) {
      if (e.kind !== 'seq') continue;
      adj.get(e.from)?.push(e.to);
      indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    }
    const queue = g.nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id);
    const order: string[] = [];
    while (queue.length) {
      const id = queue.shift()!;
      order.push(id);
      for (const to of adj.get(id) ?? []) {
        indeg.set(to, (indeg.get(to) ?? 0) - 1);
        if (indeg.get(to) === 0) queue.push(to);
      }
    }
    const rankOf = new Map<string, number>();
    order.forEach((id, i) => rankOf.set(id, i));
    for (const n of g.nodes) if (!rankOf.has(n.id)) rankOf.set(n.id, 0);

    // Member lanes: base lane 0 holds user/non-member nodes; each agent gets a lane in order of first appearance.
    const agentIndex = new Map<string, number>();
    for (const n of g.nodes) {
      if (n.agent && !agentIndex.has(n.agent)) agentIndex.set(n.agent, agentIndex.size);
    }
    const laneOf = new Map<string, number>();
    for (const n of g.nodes) laneOf.set(n.id, n.agent ? 1 + agentIndex.get(n.agent)! : 0);
    const laneColor = new Map<string, string>();
    for (const n of g.nodes) if (n.agent) laneColor.set(n.id, cat(agentIndex.get(n.agent)! + 1));
    return { rankOf, laneOf, laneColor, laneCount: agentIndex.size + 1 };
  }, [g]);

  const W = Math.max(g.nodes.length, 1) * COL_W;
  const H = Math.max(laneCount, 1) * ROW_H;
  const cx = (n: GraphNode) => rankOf.get(n.id)! * COL_W + COL_W / 2;
  const cy = (n: GraphNode) => laneOf.get(n.id)! * ROW_H + ROW_H / 2;
  const bezier = (n1: GraphNode, n2: GraphNode) => {
    const x1 = cx(n1);
    const y1 = cy(n1);
    const x2 = cx(n2);
    const y2 = cy(n2);
    const dx = Math.max((x2 - x1) * 0.5, 24);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  };
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  // A pair edge duplicates a seq edge whenever the pair's target equals the
  // call's sequential successor (tool_result is never a node). Don't overpaint.
  const seqKeys = new Set(g.edges.filter(e => e.kind === 'seq').map(e => `${e.from}->${e.to}`));

  return (
    <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface }}>
      <div style={{ display: 'flex', gap: 6, padding: '8px 10px', borderBottom: `1px solid ${C.border}`, alignItems: 'center' }}>
        {(['aggregated', 'expanded'] as const).map(m => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              fontSize: 11,
              padding: '3px 10px',
              borderRadius: 6,
              cursor: 'pointer',
              border: `1px solid ${mode === m ? C.info : C.border}`,
              background: mode === m ? C.infoSubtle : C.surfaceMuted,
              color: mode === m ? C.info : C.textMuted,
              fontWeight: mode === m ? 600 : 400,
            }}
          >
            {t(`traceHound.graph.${m}`)}
          </button>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', minWidth: W }} role="img">
        {g.edges.map((e, i) => {
          if (e.kind === 'pair' && seqKeys.has(`${e.from}->${e.to}`)) return null;
          const from = byId.get(e.from);
          const to = byId.get(e.to);
          if (!from || !to) return null;
          if (e.kind === 'cycle' && e.from === e.to) {
            const x = cx(from);
            const y = cy(from);
            return <path key={i} d={`M ${x - 12} ${y - 8} a 12 12 0 1 1 24 0`} fill="none" stroke={C.textFaint} strokeWidth={1.2} />;
          }
          const stroke = e.kind === 'cycle' ? C.warn : e.kind === 'pair' ? C.info : C.borderStrong;
          return (
            <path
              key={i}
              d={bezier(from, to)}
              fill="none"
              stroke={stroke}
              strokeWidth={e.kind === 'pair' ? 1.6 : 1.2}
              strokeDasharray={e.kind === 'cycle' ? '3 3' : undefined}
            />
          );
        })}
        {g.nodes.map(n => {
          const x = cx(n) - NODE_W / 2;
          const y = cy(n) - NODE_H / 2;
          const stroke = n.agent ? laneColor.get(n.id) : KIND_STROKE[n.kind];
          return (
            <g key={n.id} style={{ cursor: 'pointer' }} onClick={() => n.recordIds[0] && onSelectRecord(n.recordIds[0])}>
              <rect x={x} y={y} width={NODE_W} height={NODE_H} rx={6} fill={C.surface} stroke={stroke} strokeWidth={1.5} />
              <text x={cx(n)} y={cy(n) + 1} textAnchor="middle" fontSize={9} fill={C.text} style={{ pointerEvents: 'none' }}>
                {n.label}
                {n.count > 1 ? ` ×${n.count}` : ''}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
