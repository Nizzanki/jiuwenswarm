import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { HistoryRecord } from '../../stores/traceHoundStore';
import { C, cat } from './traceTokens';
import { buildGraph, layoutGraph, graphNodeTooltip, type GraphNode, type GraphMode } from './traceGraph';
import { useElementWidth } from './useElementWidth';
import { Tooltip } from './Tooltip';

const LS_MODE = 'tracehound.graphMode';
const KIND_STROKE: Record<GraphNode['kind'], string> = {
  user: C.text,
  agent: C.text,
  llm: C.violet,
  tool: C.warn,
  final: C.info,
};

function zoomBtn(label: string, title: string, onClick: () => void, active = false, disabled = false) {
  return (
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
}

/** The scrollable, zoomable graph canvas. Measures its own width so it re-fits
 *  when moved into the full-screen overlay. */
function GraphBody({
  records,
  mode,
  zoom,
  onSelectRecord,
  maxHeight,
}: {
  records: HistoryRecord[];
  mode: GraphMode;
  zoom: 'fit' | number;
  onSelectRecord: (recordIndex: number) => void;
  maxHeight: number;
}) {
  const { t } = useTranslation();
  const [wrapRef, wrapW] = useElementWidth<HTMLDivElement>();
  const g = useMemo(() => buildGraph(records, mode), [records, mode]);
  const layout = useMemo(() => layoutGraph(g.nodes), [g]);
  const byId = useMemo(() => new Map(g.nodes.map(n => [n.id, n])), [g]);
  const seqKeys = useMemo(() => new Set(g.edges.filter(e => e.kind === 'seq').map(e => `${e.from}->${e.to}`)), [g]);
  const laneColor = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of g.nodes) if (n.agent) m.set(n.id, cat(layout.laneOf.get(n.id)!));
    return m;
  }, [g, layout]);

  const fitScale = Math.min(1, wrapW / Math.max(layout.W, 1));
  const scale = zoom === 'fit' ? fitScale : zoom;
  const cx = (n: GraphNode) => layout.xOf.get(n.id)!;
  const cy = (n: GraphNode) => layout.yOf.get(n.id)!;
  const bezier = (n1: GraphNode, n2: GraphNode) => {
    const x1 = cx(n1);
    const y1 = cy(n1);
    const x2 = cx(n2);
    const y2 = cy(n2);
    const dy = Math.max((y2 - y1) * 0.5, 24);
    return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
  };

  // Drag-to-pan (both axes) when the graph overflows at numeric zoom.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const pannable = () => {
    const el = scrollRef.current;
    return !!el && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2);
  };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el || !pannable() || e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = drag.current.left - (e.clientX - drag.current.x);
    el.scrollTop = drag.current.top - (e.clientY - drag.current.y);
  };
  const endDrag = () => { drag.current = null; };

  return (
    <div ref={wrapRef}>
      <div
        ref={scrollRef}
        style={{ overflow: 'auto', maxHeight, cursor: 'grab', touchAction: 'pan-x pan-y' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <svg viewBox={`0 0 ${layout.W} ${layout.H}`} width={layout.W * scale} height={layout.H * scale} style={{ display: 'block' }} role="img">
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
            const x = cx(n) - layout.nodeW / 2;
            const y = cy(n) - layout.nodeH / 2;
            const stroke = n.agent ? laneColor.get(n.id) : KIND_STROKE[n.kind];
            return (
              <Tooltip key={n.id} text={graphNodeTooltip(n, records, t)}>
                <g style={{ cursor: 'pointer' }} onClick={() => n.recordIndexes.length > 0 && onSelectRecord(n.recordIndexes[0])}>
                  <rect x={x} y={y} width={layout.nodeW} height={layout.nodeH} rx={6} fill={C.surface} stroke={stroke} strokeWidth={1.5} />
                  <text x={cx(n)} y={cy(n) + 1} textAnchor="middle" fontSize={9} fill={C.text} style={{ pointerEvents: 'none' }}>
                    {n.label}
                    {n.count > 1 ? ` ×${n.count}` : ''}
                  </text>
                </g>
              </Tooltip>
            );
          })}
        </svg>
      </div>
      <div style={{ fontSize: 10, color: C.textFaint, textAlign: 'right', padding: '2px 10px' }}>{Math.round(scale * 100)}%</div>
    </div>
  );
}

/** Langfuse-style per-turn agent graph, drawn top→bottom (first-appearance
 *  order) with one column per agent. Fits the pane width by default with zoom
 *  controls; a full-screen button expands it into a viewport overlay. */
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
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const modeBtn = (m: GraphMode) => (
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
  );

  const toolbar = (
    <>
      {(['aggregated', 'expanded'] as const).map(modeBtn)}
      <span style={{ color: C.border, userSelect: 'none' }}>|</span>
      {zoomBtn('−', t('traceHound.graph.zoomOut'), () => setZoom(z => Math.max(0.25, (typeof z === 'number' ? z : 1) - 0.25)), false, typeof zoom === 'number' && zoom <= 0.25)}
      {zoomBtn(t('traceHound.graph.fit'), t('traceHound.graph.fitTooltip'), () => setZoom('fit'), zoom === 'fit')}
      {zoomBtn('1:1', t('traceHound.graph.actualSize'), () => setZoom(1), zoom === 1)}
      {zoomBtn('+', t('traceHound.graph.zoomIn'), () => setZoom(z => Math.min(3, (typeof z === 'number' ? z : 1) + 0.25)), false, typeof zoom === 'number' && zoom >= 3)}
      <span style={{ flex: '1 1 auto' }} />
      <button
        onClick={() => setFullscreen(true)}
        title={t('traceHound.graph.fullscreen')}
        style={{
          fontSize: 12, padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
          border: `1px solid ${C.border}`, background: C.surfaceMuted, color: C.textMuted,
        }}
      >
        ⛶
      </button>
    </>
  );

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface }}>
      <div style={{ display: 'flex', gap: 6, padding: '8px 10px', borderBottom: `1px solid ${C.border}`, alignItems: 'center', flexWrap: 'wrap' }}>
        {toolbar}
      </div>
      {!fullscreen && <GraphBody records={records} mode={mode} zoom={zoom} onSelectRecord={onSelectRecord} maxHeight={480} />}
      {fullscreen && createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: C.panel, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', gap: 6, padding: '10px 14px', borderBottom: `1px solid ${C.border}`, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{t('traceHound.graph.graph')}</span>
            {toolbar}
            <button
              onClick={() => setFullscreen(false)}
              title={t('traceHound.graph.exitFullscreen')}
              style={{
                fontSize: 12, padding: '3px 10px', borderRadius: 6, cursor: 'pointer',
                border: `1px solid ${C.borderStrong}`, background: C.surfaceMuted, color: C.text,
              }}
            >
              ✕
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}>
            <GraphBody records={records} mode={mode} zoom={zoom} onSelectRecord={onSelectRecord} maxHeight={Math.max(window.innerHeight - 140, 320)} />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
