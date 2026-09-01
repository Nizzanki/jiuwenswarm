import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHighlights } from '../node_modules/.cache/trace-highlights/highlights.js';

const turn = (over) => ({
  turn_id: 't1', turn_index: 0, user_content: 'q', tool_names: [], skill_names: [],
  has_final: true, has_error: false, error_category: null, total_tokens: 0,
  tool_failures: 0, file_count: 0, final_length: 0, duration_seconds: 5,
  retry_count: 1, was_deferred: false, query_type: 'general',
  outcome: 'completed', issues: [], mode: null, llm_call_count: 0, event_count: 1,
  ...over,
});

test('empty/healthy sessions produce no highlights', () => {
  assert.deepEqual(buildHighlights([turn({})]), []);
});

test('retries, failures, slow, problems surface', () => {
  const hs = buildHighlights([
    turn({ turn_id: 'a', retry_count: 45, outcome: 'completed_with_issues' }),
    turn({ turn_id: 'b', tool_failures: 3, duration_seconds: 1080 }),
  ]);
  const kinds = hs.map(h => h.kind).sort();
  assert.deepEqual(kinds, ['problems', 'retries', 'slowest', 'toolFailures']);
  const retries = hs.find(h => h.kind === 'retries');
  assert.equal(retries.turnIds[0], 'a');
});
