import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timelineLanes, timelineLaneOf } from '../node_modules/.cache/trace-timeline/traceTimeline.js';

const rec = over => ({ id: 'r0', role: 'user', request_id: 'q', content: '', timestamp: 1, event_type: null, ...over });

test('single-agent: user lane + one synthetic agent lane', () => {
  const records = [
    rec({ id: 'u1', role: 'user', timestamp: 1 }),
    rec({ id: 'a1', role: 'assistant', event_type: 'chat.tool_call', timestamp: 2, tool_call: { id: 'tc1', name: 'x', arguments: '{}' } }),
    rec({ id: 'a2', role: 'assistant', event_type: 'chat.final', timestamp: 3 }),
  ];
  const lanes = timelineLanes(records);
  assert.deepEqual(lanes.map(l => l.role), ['user', 'agent']);
  assert.equal(timelineLaneOf(records[0], lanes), 0); // user
  assert.equal(timelineLaneOf(records[1], lanes), 1); // unattributed assistant → agent
  assert.equal(timelineLaneOf(records[2], lanes), 1);
});

test('team mode: user + leader + members in first-appearance order', () => {
  const records = [
    rec({ id: 'u1', role: 'user', timestamp: 1 }),
    rec({ id: 'l1', role: 'leader', event_type: 'chat.tool_call', timestamp: 2 }),
    rec({ id: 'm1', role: 'teammate', member_name: 'foodie', event_type: 'chat.tool_call', timestamp: 3 }),
    rec({ id: 'm2', role: 'teammate', member_name: 'coder', event_type: 'chat.tool_call', timestamp: 4 }),
    rec({ id: 'm3', role: 'teammate', member_name: 'foodie', event_type: 'chat.final', timestamp: 5 }),
  ];
  const lanes = timelineLanes(records);
  assert.deepEqual(lanes.map(l => l.key), ['user', 'leader', 'foodie', 'coder']);
  assert.equal(timelineLaneOf(records[1], lanes), 1); // leader
  assert.equal(timelineLaneOf(records[2], lanes), 2); // foodie
  assert.equal(timelineLaneOf(records[3], lanes), 3); // coder
  assert.equal(timelineLaneOf(records[4], lanes), 2); // foodie again
});

test('team mode without a user record still yields user lane first', () => {
  const records = [
    rec({ id: 'm1', role: 'teammate', member_name: 'foodie', event_type: 'chat.tool_call', timestamp: 2 }),
  ];
  const lanes = timelineLanes(records);
  assert.deepEqual(lanes.map(l => l.key), ['user', 'foodie']);
  assert.equal(timelineLaneOf(records[0], lanes), 1);
});
