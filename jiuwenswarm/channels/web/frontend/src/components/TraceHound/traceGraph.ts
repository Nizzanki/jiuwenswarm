import type { HistoryRecord } from '../../stores/traceHoundStore';

export type GraphNode = {
  id: string;
  label: string;
  kind: 'user' | 'agent' | 'tool' | 'llm' | 'final';
  count: number;
  agent?: string;
  recordIds: string[];
};
export type GraphEdge = { from: string; to: string; kind: 'seq' | 'pair' | 'spawn' | 'cycle' };
export type GraphMode = 'aggregated' | 'expanded';

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

  const emit = (r: HistoryRecord, kind: GraphNode['kind'], label: string) => {
    const agent = agentOf(r);
    const id = mode === 'aggregated' ? `${kind}:${agent ?? ''}:${label}` : `${kind}:${agent ?? ''}:${label}:${seq.length}`;
    const ex = nodes.get(id);
    if (ex) {
      ex.count += 1;
      ex.recordIds.push(r.id);
    } else {
      nodes.set(id, { id, label, kind, count: 1, agent, recordIds: [r.id] });
    }
    seq.push(id);
    nodeKeyByRecordId.set(r.id, id);
    return id;
  };

  for (const r of records) {
    const et = r.event_type ?? (r.role === 'user' ? 'user' : '');
    if (et === 'user') {
      emit(r, 'user', 'user');
    } else if (et === 'chat.tool_call') {
      const id = emit(r, 'tool', r.tool_call?.name || r.tool_name || 'tool');
      if (r.tool_call?.id) callKeyById.set(r.tool_call.id, id);
    } else if (et === 'chat.usage_metadata') {
      emit(r, 'llm', 'llm');
    } else if (et === 'chat.final') {
      if ((r.content ?? '').trim()) emit(r, 'final', 'final');
    }
    // chat.tool_result / chat.tool_update / chat.reasoning / chat.error are not
    // nodes; tool_result participates via pairing below.
  }

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
