import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldRefetch,
  POLL_INTERVAL_MS,
} from '../node_modules/.cache/trace-live/components/TraceHound/traceLive.js';

test('refetch only when mtime actually changes', () => {
  assert.equal(shouldRefetch(null, 123.5), true); // first observation of an existing file
  assert.equal(shouldRefetch(123.5, 123.5), false); // unchanged
  assert.equal(shouldRefetch(123.5, 124.0), true); // changed
  assert.equal(shouldRefetch(123.5, null), false); // file vanished — do not hammer
  assert.equal(shouldRefetch(null, null), false);
});

test('poll interval is 5s', () => {
  assert.equal(POLL_INTERVAL_MS, 5000);
});
