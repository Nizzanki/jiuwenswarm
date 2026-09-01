import type { HistoryRecord } from '../../stores/traceHoundStore';

export type GraphNode = {
  id: string;
  label: string;
  kind: 'user' | 'agent' | 'tool' | 'llm' | 'final';
  count: number;
  agent?: string;
  /** Indices (into the source `records` array) of the records this node stands for. */
  recordIndexes: number[];
};
export type GraphEdge = { from: string; to: string; kind: 'seq' | 'pair' | 'spawn' | 'cycle' };
export type GraphMode = 'aggregated' | 'expanded';

// ── Vertical layout ───────────────────────────────────────────────────────────

export const GRID = { nodeW: 48, nodeH: 28, colW: 120, rowH: 64 } as const;

export type GraphLayout = {
  nodeW: number;
  nodeH: number;
  colW: number;
  rowH: number;
  /** Center x per node id (column = agent lane). */
  xOf: Map<string, number>;
  /** Center y per node id (row = first-appearance order, top→bottom). */
  yOf: Map<string, number>;
  /** Lane (column) index per node id; 0 = user/non-member, 1+ = agent. */
  laneOf: Map<string, number>;
  laneCount: number;
  W: number;
  H: number;
};

/** Vertical layout: first-appearance order runs top→bottom (rows) and each
 *  agent gets a column (lane). Wide graphs no longer sprawl horizontally —
 *  they grow tall and scroll down. */
export function layoutGraph(nodes: GraphNode[]): GraphLayout {
  const { nodeW, nodeH, colW, rowH } = GRID;
  const agentIndex = new Map<string, number>();
  for (const n of nodes) if (n.agent && !agentIndex.has(n.agent)) agentIndex.set(n.agent, agentIndex.size);
  const xOf = new Map<string, number>();
  const yOf = new Map<string, number>();
  const laneOf = new Map<string, number>();
  nodes.forEach((n, i) => {
    const lane = n.agent ? 1 + agentIndex.get(n.agent)! : 0;
    laneOf.set(n.id, lane);
    xOf.set(n.id, lane * colW + colW / 2);
    yOf.set(n.id, i * rowH + rowH / 2);
  });
  const laneCount = agentIndex.size + 1;
  const W = Math.max(laneCount, 1) * colW;
  const H = Math.max(nodes.length, 1) * rowH;
  return { nodeW, nodeH, colW, rowH, xOf, yOf, laneOf, laneCount, W, H };
}

// ── Node tooltip ──────────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Concise hover summary for a graph node (input/output previews). `t` is the
 *  i18n translate fn; `records` is the source record array the node indexes into. */
export function graphNodeTooltip(
  node: GraphNode,
  records: HistoryRecord[],
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const recs = node.recordIndexes.map(i => records[i]).filter(Boolean);
  const lines: string[] = [`${node.label}${node.count > 1 ? ` ×${node.count}` : ''}`];
  if (node.agent) lines.push(t('traceHound.records.byAgent', { name: node.agent }));

  const preview = (r: HistoryRecord): string => {
    if (r.role === 'user') return truncate(r.content ?? '', 120);
    const et = r.event_type ?? '';
    if (et === 'chat.tool_call') {
      const args = (r.tool_call as Record<string, unknown> | undefined)?.arguments ?? r.content ?? '';
      let s = '';
      try { s = JSON.stringify(typeof args === 'string' ? JSON.parse(args) : args); } catch { s = String(args); }
      return truncate(s, 100);
    }
    if (et === 'chat.tool_result') return truncate(r.result ?? r.content ?? '', 100);
    if (et === 'chat.usage_metadata') {
      const um = r.metadata?.usage_metadata;
      const parts: string[] = [];
      if (um?.model_name) parts.push(um.model_name);
      if (um?.input_tokens != null) parts.push(`${um.input_tokens}→${um.output_tokens ?? '?'} tok`);
      if (um?.total_latency != null) parts.push(`${um.total_latency}s`);
      return parts.join(' · ');
    }
    if (et === 'chat.final') return truncate(r.content ?? '', 120);
    return truncate(r.content ?? '', 100);
  };

  const shown = recs.slice(0, 3);
  for (const r of shown) lines.push(preview(r));
  if (recs.length > shown.length) lines.push(`… +${recs.length - shown.length}`);
  return lines.filter(l => l && l.trim()).join('\n');
}

/** Build the agent-workflow graph for one turn from its history records.
 *  Edges are inferred: temporal sequence, tool_call_id pairing, spawn links.
 *  In aggregated mode, records collapse per (agent, kind, label) with a count
 *  and repeated edges become self-loop cycle arcs; in expanded mode every call
 *  is its own node and tool_call→tool_result pairs get explicit pair edges. */
export function buildGraph(records: HistoryRecord[], mode: GraphMode): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const seq: string[] = []; // ordered expanded node ids
  // Expanded node keys are positional (`seq.length` at creation); keep the exact
  // key each record produced so pairing edges can target the right node.
  const nodeKeyByRecordId = new Map<string, string>();
  const callKeyById = new Map<string, string>();

  const agentOf = (r: HistoryRecord) => (r.member_name ?? '').trim() || undefined;

  const emit = (r: HistoryRecord, idx: number, kind: GraphNode['kind'], label: string) => {
    const agent = agentOf(r);
    const id = mode === 'aggregated' ? `${kind}:${agent ?? ''}:${label}` : `${kind}:${agent ?? ''}:${label}:${seq.length}`;
    const ex = nodes.get(id);
    if (ex) {
      ex.count += 1;
      ex.recordIndexes.push(idx);
    } else {
      nodes.set(id, { id, label, kind, count: 1, agent, recordIndexes: [idx] });
    }
    seq.push(id);
    nodeKeyByRecordId.set(r.id, id);
    return id;
  };

  records.forEach((r, idx) => {
    const et = r.event_type ?? (r.role === 'user' ? 'user' : '');
    if (et === 'user') {
      emit(r, idx, 'user', 'user');
    } else if (et === 'chat.tool_call') {
      const id = emit(r, idx, 'tool', r.tool_call?.name || r.tool_name || 'tool');
      if (r.tool_call?.id) callKeyById.set(r.tool_call.id, id);
    } else if (et === 'chat.usage_metadata') {
      emit(r, idx, 'llm', 'llm');
    } else if (et === 'chat.final') {
      if ((r.content ?? '').trim()) emit(r, idx, 'final', 'final');
    }
    // chat.tool_result / chat.tool_update / chat.reasoning / chat.error are not
    // nodes; tool_result participates via pairing below.
  });

  // Sequential edges along record order. In aggregated mode a repeated edge
  // (same pair of collapsed nodes) is emitted once as a cycle arc instead.
  const seen = new Set<string>();
  for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1];
    const b = seq[i];
    if (a === b) continue;
    const k = `${a}->${b}`;
    if (seen.has(k)) {
      if (mode === 'aggregated') edges.push({ from: a, to: b, kind: 'cycle' });
    } else {
      seen.add(k);
      edges.push({ from: a, to: b, kind: 'seq' });
    }
  }

  // Pairing: each tool_call connects to the next node after its tool_result
  // (the call's output feeds the following step). Expanded mode renders these
  // as explicit pair edges.
  for (const r of records) {
    if (r.event_type !== 'chat.tool_result' || !r.tool_call_id) continue;
    const callRec = records.find(x => x.event_type === 'chat.tool_call' && x.tool_call?.id === r.tool_call_id);
    if (!callRec) continue;
    const idx = records.findIndex(x => x.id === r.id);
    const follower = records
      .slice(idx + 1)
      .find(
        nx => nx.event_type === 'chat.tool_call' || nx.event_type === 'chat.usage_metadata' || (nx.event_type === 'chat.final' && (nx.content ?? '').trim()),
      );
    const fromKey = callKeyById.get(r.tool_call_id);
    const toKey = follower ? nodeKeyByRecordId.get(follower.id) : undefined;
    if (fromKey && toKey && fromKey !== toKey) {
      edges.push({ from: fromKey, to: toKey, kind: 'pair' });
    }
  }

  // Aggregated mode: a collapsed tool (or llm/final) invoked more than once
  // gets a self-loop cycle arc — the "same-name tools collapse with counter +
  // cycle" invariant.
  if (mode === 'aggregated') {
    for (const n of nodes.values()) {
      if (n.count > 1) edges.push({ from: n.id, to: n.id, kind: 'cycle' });
    }
  }

  return { nodes: [...nodes.values()], edges };
}
