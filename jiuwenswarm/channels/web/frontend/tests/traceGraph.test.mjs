import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, layoutGraph, graphNodeTooltip } from '../node_modules/.cache/trace-graph/traceGraph.js';

const rec = over => ({ id: 'r0', role: 'user', request_id: 'q', content: '', timestamp: 1, event_type: null, ...over });
const records = [
  rec({ id: 'u1', role: 'user', content: 'go', timestamp: 1 }),
  rec({
    id: 'm1',
    event_type: 'chat.usage_metadata',
    timestamp: 2,
    member_name: 'foodie',
    metadata: { usage_metadata: { total_tokens: 5, total_cost: 0, model_name: 'm' } },
  }),
  rec({
    id: 't1',
    event_type: 'chat.tool_call',
    timestamp: 3,
    tool_name: 'search',
    tool_call: { id: 'tc1', name: 'search', arguments: '{}' },
    member_name: 'foodie',
  }),
  rec({ id: 'r1', event_type: 'chat.tool_result', timestamp: 4, tool_name: 'search', tool_call_id: 'tc1', result: 'ok', member_name: 'foodie' }),
  rec({
    id: 't2',
    event_type: 'chat.tool_call',
    timestamp: 5,
    tool_name: 'search',
    tool_call: { id: 'tc2', name: 'search', arguments: '{}' },
    member_name: 'foodie',
  }),
  rec({ id: 'r2', event_type: 'chat.tool_result', timestamp: 6, tool_name: 'search', tool_call_id: 'tc2', result: 'ok', member_name: 'foodie' }),
  rec({ id: 'f1', event_type: 'chat.final', role: 'assistant', content: 'done', timestamp: 7 }),
];

test('expanded: one node per call, paired edges', () => {
  const g = buildGraph(records, 'expanded');
  const tools = g.nodes.filter(n => n.kind === 'tool');
  assert.equal(tools.length, 2);
  assert.ok(g.edges.some(e => e.kind === 'pair')); // tc call→result
  assert.ok(g.edges.every(e => e.kind !== 'cycle'));
});

test('aggregated: same-name tools collapse with counter + cycle', () => {
  const g = buildGraph(records, 'aggregated');
  const tools = g.nodes.filter(n => n.kind === 'tool' && n.label === 'search');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].count, 2);
  assert.ok(g.edges.some(e => e.kind === 'cycle'));
});

test('aggregated: nodes keep first-appearance order (no rank-0 pile on cycles)', () => {
  // user→final→grep→final→grep→final: seq edges contain a final⇄grep cycle.
  // The graph must still emit every node distinctly, in record order — the
  // renderer derives columns from node order, so duplicates here would stack.
  const cyclic = [
    rec({ id: 'u1', role: 'user', content: 'go', timestamp: 1 }),
    rec({ id: 'f1', event_type: 'chat.final', role: 'assistant', content: 'a', timestamp: 2 }),
    rec({ id: 't1', event_type: 'chat.tool_call', timestamp: 3, tool_name: 'grep', tool_call: { id: 'tc1', name: 'grep', arguments: '{}' } }),
    rec({ id: 'f2', event_type: 'chat.final', role: 'assistant', content: 'b', timestamp: 4 }),
    rec({ id: 't2', event_type: 'chat.tool_call', timestamp: 5, tool_name: 'grep', tool_call: { id: 'tc2', name: 'grep', arguments: '{}' } }),
    rec({ id: 'f3', event_type: 'chat.final', role: 'assistant', content: 'c', timestamp: 6 }),
  ];
  const g = buildGraph(cyclic, 'aggregated');
  // one collapsed node per (kind,label): user, final, grep — nothing merged away
  assert.deepEqual(g.nodes.map(n => n.label), ['user', 'final', 'grep']);
  // counts preserved on the collapsed nodes
  assert.equal(g.nodes.find(n => n.label === 'final')?.count, 3);
  assert.equal(g.nodes.find(n => n.label === 'grep')?.count, 2);
});

test('layoutGraph: vertical rows, one column per agent', () => {
  const g = buildGraph(records, 'aggregated');
  const L = layoutGraph(g.nodes);
  const byLabel = Object.fromEntries(g.nodes.map(n => [n.label, n]));
  // user + final sit on lane 0; foodie nodes on lane 1
  assert.equal(L.laneOf.get(byLabel.user.id), 0);
  assert.equal(L.laneOf.get(byLabel.llm.id), 1);
  assert.equal(L.laneOf.get(byLabel.search.id), 1);
  assert.equal(L.laneOf.get(byLabel.final.id), 0);
  // rows descend in first-appearance order (top→bottom)
  const ys = g.nodes.map(n => L.yOf.get(n.id));
  assert.ok(ys.every((y, i) => i === 0 || y > ys[i - 1]));
  assert.equal(L.W, 2 * L.colW);
  assert.equal(L.H, g.nodes.length * L.rowH);
});

test('graphNodeTooltip: concise per-kind previews', () => {
  const g = buildGraph(records, 'aggregated');
  const t = (k, o) => (k === 'traceHound.records.byAgent' ? `by ${o?.name}` : k);
  const tool = g.nodes.find(n => n.kind === 'tool');
  const tip = graphNodeTooltip(tool, records, t);
  assert.ok(tip.includes('search'));
  assert.ok(tip.includes('foodie'));
  const user = g.nodes.find(n => n.kind === 'user');
  assert.ok(graphNodeTooltip(user, records, t).includes('go'));
});
