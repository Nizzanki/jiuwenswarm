import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryRecord } from '../../stores/traceHoundStore';
import { C, cat } from './traceTokens';
import { buildGraph, type GraphNode, type GraphMode } from './traceGraph';
import { useElementWidth } from './useElementWidth';

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

/** Langfuse-style per-turn agent graph. Columns follow first-appearance order
 *  of the collapsed/expanded nodes, rows group them into member lanes, and
 *  each tool call is paired with the node following its result.
 *  Wide graphs scale down to fit the pane (zoom controls for detail). */
export function TraceGraph({ records, onSelectRecord }: { records: HistoryRecord[]; onSelectRecord: (recordIndex: number) => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<GraphMode>(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem(LS_MODE) === 'expanded' ? 'expanded' : 'aggregated',
  );
  useEffect(() => {
    localStorage.setItem(LS_MODE, mode);
  }, [mode]);

  // 'fit' scales the whole graph down to the pane width (never up);
  // numeric zoom is an absolute scale with scroll + drag-to-pan.
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const [wrapRef, wrapW] = useElementWidth<HTMLDivElement>();

  const g = useMemo(() => buildGraph(records, mode), [records, mode]);

  const { rankOf, laneOf, laneColor, laneCount } = useMemo(() => {
    // Column = first-appearance index. A topological sort is wrong here:
    // aggregated seq edges always contain cycles (llm→tool→llm), which used
    // to dump every cycle member into the same rank-0 pile.
    const rankOf = new Map<string, number>();
    g.nodes.forEach((n, i) => rankOf.set(n.id, i));

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
  const fitScale = Math.min(1, wrapW / Math.max(W, 1));
  const scale = zoom === 'fit' ? fitScale : zoom;
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

  // Drag-to-pan when the graph is wider than the viewport (numeric zoom).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; left: number } | null>(null);
  const pannable = () => {
    const el = scrollRef.current;
    return !!el && el.scrollWidth > el.clientWidth + 2;
  };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el || !pannable() || e.button !== 0) return;
    drag.current = { x: e.clientX, left: el.scrollLeft };
    el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = drag.current.left - (e.clientX - drag.current.x);
  };
  const endDrag = () => { drag.current = null; };

  const zoomBtn = (label: string, title: string, onClick: () => void, active = false, disabled = false) => (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        fontSize: 11, padding: '3px 8px', borderRadius: 6, cursor: disabled ? 'default' : 'pointer',
        border: `1px solid ${active ? C.info : C.border}`,
        background: active ? C.infoSubtle : C.surfaceMuted,
        color: active ? C.info : C.textMuted,
        fontWeight: active ? 600 : 400,
      }}
    >
      {label}
    </button>
  );

  return (
    <div ref={wrapRef} style={{ border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface }}>
      <div style={{ display: 'flex', gap: 6, padding: '8px 10px', borderBottom: `1px solid ${C.border}`, alignItems: 'center', flexWrap: 'wrap' }}>
        {(['aggregated', 'expanded'] as const).map(m => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              fontSize: 11, padding: '3px 10px', borderRadius: 6, cursor: 'pointer',
              border: `1px solid ${mode === m ? C.info : C.border}`,
              background: mode === m ? C.infoSubtle : C.surfaceMuted,
              color: mode === m ? C.info : C.textMuted,
              fontWeight: mode === m ? 600 : 400,
            }}
          >
            {t(`traceHound.graph.${m}`)}
          </button>
        ))}
        <span style={{ color: C.border, userSelect: 'none' }}>|</span>
        {zoomBtn('−', t('traceHound.graph.zoomOut'), () => setZoom(z => Math.max(0.25, (typeof z === 'number' ? z : 1) - 0.25)), false, typeof zoom === 'number' && zoom <= 0.25)}
        {zoomBtn(t('traceHound.graph.fit'), t('traceHound.graph.fitTooltip'), () => setZoom('fit'), zoom === 'fit')}
        {zoomBtn('1:1', t('traceHound.graph.actualSize'), () => setZoom(1), zoom === 1)}
        {zoomBtn('+', t('traceHound.graph.zoomIn'), () => setZoom(z => Math.min(3, (typeof z === 'number' ? z : 1) + 0.25)), false, typeof zoom === 'number' && zoom >= 3)}
        <span style={{ fontSize: 10, color: C.textFaint, marginLeft: 'auto' }}>{Math.round(scale * 100)}%</span>
      </div>
      <div
        ref={scrollRef}
        style={{ overflowX: 'auto', cursor: 'grab', touchAction: 'pan-y' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <svg viewBox={`0 0 ${W} ${H}`} width={W * scale} height={H * scale} style={{ display: 'block' }} role="img">
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
              <g key={n.id} style={{ cursor: 'pointer' }} onClick={() => n.recordIndexes.length > 0 && onSelectRecord(n.recordIndexes[0])}>
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
    </div>
  );
}
