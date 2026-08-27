import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../node_modules/.cache/trace-graph/traceGraph.js';

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
