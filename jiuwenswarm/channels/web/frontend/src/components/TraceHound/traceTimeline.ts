import type { HistoryRecord } from '../../stores/traceHoundStore';

/** A horizontal lane in the per-agent timeline swimlane. */
export type TimelineLane = { key: string; role: 'user' | 'leader' | 'member' | 'agent' };

/**
 * Build the timeline lanes: a 'user' lane (always first) followed by one lane
 * per acting agent in first-appearance order. Team-mode events carry
 * `member_name` (member) or `role === 'leader'`; single-agent events carry
 * neither, so they collapse onto a single synthetic 'agent' lane.
 */
export function timelineLanes(records: HistoryRecord[]): TimelineLane[] {
  const agentKeys: string[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    const key = r.member_name ? r.member_name : r.role === 'leader' ? 'leader' : '';
    if (key && !seen.has(key)) {
      seen.add(key);
      agentKeys.push(key);
    }
  }
  const agents = agentKeys.length > 0 ? agentKeys : ['agent'];
  const lanes: TimelineLane[] = [{ key: 'user', role: 'user' }];
  for (const k of agents) {
    lanes.push({ key: k, role: k === 'leader' ? 'leader' : k === 'agent' ? 'agent' : 'member' });
  }
  return lanes;
}

/** Lane index a record belongs to. User records → lane 0; unattributed
 *  single-agent events → the synthetic 'agent' lane; team events → their
 *  agent's lane. Falls back to 0 when no lane matches. */
export function timelineLaneOf(rec: HistoryRecord, lanes: TimelineLane[]): number {
  if (rec.role === 'user') return 0;
  const key = rec.member_name ? rec.member_name : rec.role === 'leader' ? 'leader' : '';
  if (!key) {
    const idx = lanes.findIndex(l => l.role === 'agent');
    return idx >= 0 ? idx : 0;
  }
  const idx = lanes.findIndex(l => l.key === key);
  return idx >= 0 ? idx : 0;
}
