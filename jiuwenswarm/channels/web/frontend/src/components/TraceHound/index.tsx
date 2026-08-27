/**
 * TraceHoundPanel — TraceHound / Trajectory Viewer
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useTraceHoundStore, type HistoryRecord, type TurnSummary, type AnalysisIssue, type AgentActivity } from '../../stores/traceHoundStore';
import { webRequest } from '../../services/webClient';
import { C } from './traceTokens';
import { shouldRefetch, POLL_INTERVAL_MS } from './traceLive';
import { buildHighlights } from './highlights';
import { TimelineBand, PerAgentCard } from './traceCharts';
import { TraceGraph } from './TraceGraph';

// ── Shared styles ─────────────────────────────────────────────────────────────

const panelStyle: React.CSSProperties = {
  padding: '20px 24px', height: '100%', width: '100%', flex: 1,
  overflowY: 'auto', boxSizing: 'border-box',
  fontFamily: 'var(--font-family, sans-serif)', minWidth: 0,
};
const headerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  marginBottom: 20, gap: 12, flexWrap: 'wrap',
};
const titleStyle: React.CSSProperties = {
  fontSize: 18, fontWeight: 700, color: C.text, margin: 0,
};
const btnStyle: React.CSSProperties = {
  padding: '5px 12px', borderRadius: 6, border: `1px solid ${C.borderStrong}`,
  background: C.surfaceMuted, cursor: 'pointer', fontSize: 13, color: C.text,
  whiteSpace: 'nowrap',
};
const cardStyle: React.CSSProperties = {
  border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 16px',
  marginBottom: 10, cursor: 'pointer', background: C.surface, transition: 'border-color 0.15s',
};
const emptyStyle: React.CSSProperties = {
  padding: 40, textAlign: 'center', color: C.textFaint, fontSize: 14,
};
const chipStyle: React.CSSProperties = {
  fontSize: 12, padding: '2px 8px', borderRadius: 4,
  background: C.surfaceMuted, color: C.text,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(ts: number): string {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtDateTime(ts: number): string {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}
function fmtDuration(s: number): string {
  if (s <= 0) return '';
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}
function fmtDelta(s: number): string {
  if (s <= 0) return '+0s';
  if (s < 60) return `+${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `+${fmtDuration(s)}`;
}

function modeBadge(mode: string | null | undefined): React.ReactNode {
  if (!mode || mode === 'unknown') return null;
  const colors: Record<string, { color: string; subtle: string }> = {
    'agent.plan': { color: C.info, subtle: C.infoSubtle },
    'code.plan': { color: C.violet, subtle: C.violetSubtle },
    team: { color: C.ok, subtle: C.okSubtle },
  };
  const mb = colors[mode] ?? { color: C.textMuted, subtle: C.surfaceMuted };
  return (
    <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: mb.subtle, color: mb.color, border: `1px solid ${mb.subtle}`, marginRight: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
      {mode}
    </span>
  );
}

// ── Team agent attribution ───────────────────────────────────────────────────

const AGENT_PALETTE = [C.info, C.warn, C.violet, C.danger, C.teal, C.ok];

function agentColor(name: string): string {
  if (name === 'leader') return C.textMuted;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AGENT_PALETTE[h % AGENT_PALETTE.length];
}

/** Resolve the acting agent (member_name, else 'leader') for a team record. */
function recordAgent(rec: HistoryRecord): string {
  if (rec.member_name) return rec.member_name;
  if (rec.role === 'leader') return 'leader';
  return '';
}

/** Small colored tag for a team agent (leader gets a neutral slate tag). */
function agentTag(name: string, t: TFunction, withDot = true): React.ReactNode {
  const color = agentColor(name);
  return (
    <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 3, background: C.surfaceMuted, color, border: `1px solid ${C.border}`, flexShrink: 0, whiteSpace: 'nowrap' }}>
      {name === 'leader' ? `⛨ ${t('traceHound.perAgent.leader')}` : (withDot ? `◈ ${name}` : name)}
    </span>
  );
}

// ── Custom tooltip (browser title= is unreliable/slow) ────────────────────────

function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  const handleEnter = (e: React.MouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setPos({ x: rect.left + rect.width / 2, y: rect.top });
    setShow(true);
  };

  // If child is a React element, attach handlers directly — no wrapper.
  // This lets the child remain a direct flex item in its parent row.
  if (React.isValidElement(children)) {
    return (
      <>
        {React.cloneElement(children, {
          onMouseEnter: handleEnter,
          onMouseLeave: () => setShow(false),
        } as any)}
        {show && text && createPortal(
          <div style={{
            position: 'fixed', top: pos.y - 8, left: pos.x, transform: 'translate(-50%, -100%)',
            background: C.text, color: C.surface, fontSize: 11, padding: '8px 10px',
            borderRadius: 6, whiteSpace: 'pre-wrap', zIndex: 2147483647, minWidth: 180, maxWidth: 300,
            boxShadow: '0 4px 16px rgba(0,0,0,0.35)', pointerEvents: 'none', lineHeight: 1.5,
          }}>
            {text}
            <div style={{ position: 'absolute', bottom: -5, left: '50%', transform: 'translateX(-50%)', width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: `5px solid ${C.text}` }} />
          </div>,
          document.body
        )}
      </>
    );
  }

  // For text / fragment children, fall back to a span wrapper
  return (
    <>
      <span
        style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
        onMouseEnter={handleEnter}
        onMouseLeave={() => setShow(false)}
      >
        {children}
      </span>
      {show && text && createPortal(
        <div style={{
          position: 'fixed', top: pos.y - 8, left: pos.x, transform: 'translate(-50%, -100%)',
          background: C.text, color: C.surface, fontSize: 11, padding: '8px 10px',
          borderRadius: 6, whiteSpace: 'pre-wrap', zIndex: 2147483647, minWidth: 180, maxWidth: 300,
          boxShadow: '0 4px 16px rgba(0,0,0,0.35)', pointerEvents: 'none', lineHeight: 1.5,
        }}>
          {text}
          <div style={{ position: 'absolute', bottom: -5, left: '50%', transform: 'translateX(-50%)', width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: `5px solid ${C.text}` }} />
        </div>,
        document.body
      )}
    </>
  );
}

/** Color for each outcome type — used in charts, badges, timeline bars */
const OUTCOME_COLORS: Record<string, string> = {
  completed: C.info,
  completed_with_issues: C.warn,
  no_response: C.violet,
  error: C.danger,
  deferred: C.ok,
};

/** Tinted background for each outcome type (for badges/chips). */
const OUTCOME_SUBTLE: Record<string, string> = {
  completed: C.infoSubtle,
  completed_with_issues: C.warnSubtle,
  no_response: C.violetSubtle,
  error: C.dangerSubtle,
  deferred: C.okSubtle,
};

/** i18n key (under `traceHound.outcomes`) for each outcome name. */
const OUTCOME_LABEL_KEYS: Record<string, string> = {
  completed: 'completed',
  completed_with_issues: 'withProblems',
  no_response: 'noResponse',
  error: 'error',
  deferred: 'deferred',
};

function outcomeLabel(outcome: string, t: TFunction): string {
  const key = OUTCOME_LABEL_KEYS[outcome];
  return key ? t(`traceHound.outcomes.${key}`) : outcome.replace(/_/g, ' ');
}

/** Approximate bar height score for visual charts */
function outcomeScore(t: TurnSummary): number {
  switch (t.outcome) {
    case 'completed': return 0.9;
    case 'completed_with_issues': return 0.65;
    case 'no_response': return 0.2;
    case 'deferred': return 0.3;
    default: return 0.1;
  }
}

/** Outcome badge — shows the actual outcome name (completed / with problems / no response / error / deferred) */
function OutcomeBadge({ outcome, issues, t }: { outcome: string; issues: string[]; t: TFunction }) {
  const color = OUTCOME_COLORS[outcome] ?? C.textMuted;
  const label = outcomeLabel(outcome, t);
  const tip = issues.length > 0 ? issues.join('\n') : '';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: OUTCOME_SUBTLE[outcome] ?? C.surfaceMuted, color, border: `1px solid ${OUTCOME_SUBTLE[outcome] ?? C.border}`, textTransform: 'capitalize' }}>
        {label}
      </span>
      {tip && (
        <Tooltip text={tip}>
          <span style={{ fontSize: 11, color: C.textFaint, cursor: 'help', fontWeight: 700, lineHeight: 1 }}>?</span>
        </Tooltip>
      )}
    </span>
  );
}

function queryTypeBadge(qt: string | null | undefined): React.ReactNode {
  if (!qt || qt === 'general') return null;
  const map: Record<string, string> = { coding: '💻', debug: '🐛', file_op: '📁', analysis: '🔍', question: '❓' };
  return (
    <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: C.surfaceMuted, color: C.textMuted, border: `1px solid ${C.border}` }}>
      {map[qt] ?? ''} {qt}
    </span>
  );
}


const DANGEROUS_PATTERNS = [
  /rm\s+-rf/i, /rm\s+-r\s+-f/i, /DROP\s+TABLE/i, /DROP\s+DATABASE/i,
  /sudo\s+rm/i, /mkfs/i, /dd\s+if=/i, /chmod\s+777/i, />\s*\/dev\/sd/i, /truncate.*--size\s+0/i,
];
function isDangerous(rec: HistoryRecord): boolean {
  if (rec.event_type !== 'chat.tool_call') return false;
  const args = JSON.stringify((rec.tool_call as Record<string, unknown>)?.arguments ?? '') + (rec.content ?? '');
  return DANGEROUS_PATTERNS.some(p => p.test(args));
}

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function downloadText(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isFailedToolResult(rec: HistoryRecord): boolean {
  if (rec.error_type) return true;
  // Team-mode tool errors serialize into the result string with no structured
  // error fields (e.g. `success=False data=None error='...'`).
  return typeof rec.result === 'string' && rec.result.includes('success=False');
}

function recordHeaderLabel(rec: HistoryRecord, t: TFunction): string {
  const key = rec.role === 'user' ? 'user' : (rec.event_type ?? '');
  const meta = EVENT_META[key];
  const label = meta
    ? t(`traceHound.records.events.${meta.labelKey}`)
    : (rec.event_type ?? rec.role);
  const subLabel = rec.subagent_type ? t('traceHound.records.subagent', { type: rec.subagent_type }) : '';
  const agentName = recordAgent(rec);
  const agentLabel = agentName ? t('traceHound.records.byAgent', { name: agentName }) : '';
  const toolName = rec.tool_name ?? (rec.tool_call as Record<string, unknown>)?.name ?? '';
  if (key === 'chat.tool_call') return `${t('traceHound.records.labeled', { label, name: toolName })}${subLabel}${agentLabel}`;
  if (key === 'chat.tool_result') return `${t('traceHound.records.labeled', { label, name: rec.tool_name ?? '' })}${subLabel}${agentLabel}`;
  if (key === 'chat.tool_update') return `${t('traceHound.records.labeled', { label, name: rec.tool_name ?? '' })}${subLabel}${agentLabel}`;
  if (key === 'chat.usage_metadata') return `${t('traceHound.records.labeled', { label, name: rec.metadata?.usage_metadata?.model_name ?? '' })}${subLabel}${agentLabel}`;
  return `${label}${subLabel}${agentLabel}`;
}

// Serialize a history record as plain text, mirroring exactly what its on-screen
// card shows (header label, body, tool arguments/result, LLM usage + prompt +
// response, session id) so a downloaded page has the same boxes, order and data.
function recordToText(rec: HistoryRecord, allRecords: HistoryRecord[], t: TFunction): string {
  const key = rec.role === 'user' ? 'user' : (rec.event_type ?? '');
  const meta = EVENT_META[key];
  const icon = key === 'chat.tool_result' ? (isFailedToolResult(rec) ? '❌' : '✅') : (meta?.icon ?? '•');
  const header = `${icon} ${recordHeaderLabel(rec, t)}`;
  const lines: string[] = [header];

  const bodyText = key === 'chat.error' ? (rec.error ?? rec.error_detail ?? rec.content ?? '') : (rec.content ?? '');

  if (key === 'user' || key === 'chat.final') {
    if (bodyText) lines.push('', bodyText);
  } else if (key === 'chat.tool_call') {
    const args = (rec.tool_call as Record<string, unknown>)?.arguments ?? rec.content;
    let fmtArgs = '';
    try { fmtArgs = JSON.stringify(typeof args === 'string' ? JSON.parse(args) : args, null, 2); }
    catch { fmtArgs = String(args ?? ''); }
    if (fmtArgs) lines.push('', 'Arguments:', fmtArgs);
  } else if (key === 'chat.tool_result') {
    const resultText = rec.result ?? rec.content ?? '';
    if (rec.error_type) lines.push('', `Error type: ${rec.error_type}${rec.error_detail ? ` — ${rec.error_detail}` : ''}`);
    else if (isFailedToolResult(rec)) lines.push('', 'Error: tool call failed (success=False)');
    if (resultText) lines.push('', 'Result:', resultText);
    if (rec.raw_output) {
      try { lines.push('', 'Raw Output:', JSON.stringify(rec.raw_output, null, 2)); }
      catch { lines.push('', 'Raw Output:', String(rec.raw_output)); }
    }
  } else if (key === 'chat.reasoning' || key === 'chat.file' || key === 'chat.error') {
    if (bodyText) lines.push('', bodyText);
  } else if (key === 'chat.usage_metadata') {
    const um = rec.metadata?.usage_metadata;
    if (um) {
      const chips: string[] = [];
      if (um.model_name) chips.push(`model: ${um.model_name}`);
      if (um.input_tokens != null && um.output_tokens != null) chips.push(`${um.input_tokens} in / ${um.output_tokens} out = ${um.total_tokens ?? '?'} tot`);
      if (um.cache_tokens != null && um.cache_tokens > 0) chips.push(`cache: ${um.cache_tokens}`);
      if (um.total_cost != null && um.total_cost > 0) chips.push(`cost: $${um.total_cost.toFixed(4)}`);
      if (chips.length) lines.push('', chips.join(' · '));
      if (rec.metadata?.total_latency_ms != null) {
        lines.push(`latency: ${(rec.metadata.total_latency_ms / 1000).toFixed(2)}s total${rec.metadata.ttft_ms != null ? `, TTFT ${rec.metadata.ttft_ms.toFixed(0)}ms` : ''}${rec.metadata.tpot_ms != null ? `, TPOT ${rec.metadata.tpot_ms.toFixed(1)}ms` : ''}`);
      }
      if (um.prompt) lines.push('', 'LLM Prompt:', um.prompt);
      const responseRecs = findLLMResponseForUsage(rec, allRecords ?? []);
      const parts: string[] = [];
      for (const r of responseRecs) {
        if (r.event_type === 'chat.final' && r.content) parts.push(`Response (final):\n${r.content}`);
        else if (r.event_type === 'chat.llm_call_end' && r.content) parts.push(`Response:\n${r.content}`);
        else if (r.event_type === 'chat.tool_call') parts.push(`Tool: ${(r.tool_call as Record<string, unknown>)?.name ?? r.tool_name ?? 'unknown'}`);
        else if (r.event_type === 'chat.reasoning' && r.content) parts.push(`Reasoning:\n${r.content}`);
        else if (r.event_type === 'chat.error') parts.push(`Error: ${r.error ?? r.error_detail ?? r.content ?? ''}`);
      }
      if (parts.length) lines.push('', parts.join('\n\n'));
    }
  }

  if (rec.session_id) lines.push('', `session: ${rec.session_id}`);
  return lines.join('\n');
}

// ── Step-by-step markdown export ──────────────────────────────────────────────
// Mirrors docs-michael/step-by-step.md: one "### N. <Agent> Trace" section per
// sub-agent (plus the main orchestrator), each a markdown table of
// Operation | Technical Telemetry & Metrics | Latency | Input | Output.

function formatLatencyS(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  if (sec >= 60) {
    let m = Math.floor(sec / 60);
    let s = Math.round(sec % 60);
    if (s === 60) { m += 1; s = 0; }
    return s > 0 ? `~${m}m ${s}s` : `~${m}m`;
  }
  return `~${sec.toFixed(1)}s`;
}

function mdEsc(s: string): string {
  return (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ');
}

function mdTrunc(s: string, n: number): string {
  const t = s ?? '';
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// The prompt preview is "<system>…\n<user>…\n…". For a readable table cell the
// useful part is the actual user query, not the system preamble — take the text
// after the last "<user>" marker.
function lastUserSegment(prompt: string): string {
  const idx = prompt.lastIndexOf('<user>');
  return idx >= 0 ? prompt.slice(idx + 6) : prompt;
}

// The main agent's user message is wrapped in an envelope:
// "You receive a new message: {"source": "web", ..., "content": "<real text>"}".
// Unwrap it so the cell shows the actual user message, not the JSON envelope.
function extractUserMessage(prompt: string): string {
  const seg = lastUserSegment(prompt);
  const start = seg.indexOf('{');
  const end = seg.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(seg.slice(start, end + 1));
      const content = parsed?.content;
      if (typeof content === 'string' && content.trim()) return content;
      if (Array.isArray(content)) {
        const text = content
          .filter((p: Record<string, unknown>) => p && p.type === 'text' && typeof p.text === 'string')
          .map((p: Record<string, unknown>) => p.text)
          .join('\n');
        if (text.trim()) return text;
      }
    } catch { /* not the envelope JSON — fall through */ }
  }
  return seg;
}

// Extract the first http(s) URL found anywhere in a tool-call's parsed args.
// Used to pair a tool_result back to its tool_call when several identical tools
// ran in parallel (tool_call_id is the shared card id, not a per-call id).
function extractUrlSignature(fmtArgs: string): string {
  try {
    const parsed = JSON.parse(fmtArgs);
    const stack: unknown[] = [parsed];
    while (stack.length) {
      const v = stack.pop();
      if (typeof v === 'string') {
        const m = v.match(/https?:\/\/[^\s"'\\]+/);
        if (m) return m[0];
      } else if (Array.isArray(v)) {
        stack.push(...v);
      } else if (v && typeof v === 'object') {
        stack.push(...Object.values(v as Record<string, unknown>));
      }
    }
  } catch { /* ignore */ }
  return '';
}

// Host of the call's URL — a weaker but still useful signal: fetch_webpage
// results often echo a redirected URL (captcha, canonical page) that differs
// from the requested one but keeps the same host.
function extractHostSignature(fmtArgs: string): string {
  const url = extractUrlSignature(fmtArgs);
  const m = url.match(/^https?:\/\/([^/]+)/);
  return m ? m[1] : '';
}

// A fetch_webpage result echoes its URL ("URL: <url>\nStatus: 200 ..."), which
// already appears in the Input cell. Drop that first line for the Output cell.
function summarizeToolResult(resultText: string): string {
  const t = resultText.trim();
  if (t.startsWith('URL:')) {
    const nl = t.indexOf('\n');
    return nl >= 0 ? t.slice(nl + 1).trim() : '';
  }
  return t;
}

// Pair each tool_call with its tool_result. Parallel results arrive in
// completion order and can be interleaved with later LLM calls, so this is a
// greedy match over the whole section, in four passes of decreasing precision:
//   0. unique tool_call_id — the call's id appears once and a result carries it
//      (main agent's task_tool calls; sub-agent tools share a stable card id)
//   1. exact URL — the result text contains the call's requested URL
//   2. host — the result text contains the call's host (redirects/captchas)
//   3. same name — earliest unclaimed result of that tool after the call
function buildToolPairings(records: HistoryRecord[]): Map<number, { latency: string; output: string }> {
  const pairings = new Map<number, { latency: string; output: string }>();
  const idCounts = new Map<string, number>();
  records.forEach(r => {
    if ((r.event_type ?? '') === 'chat.tool_call') {
      const cid = String((r.tool_call as Record<string, unknown>)?.tool_call_id ?? '');
      if (cid) idCounts.set(cid, (idCounts.get(cid) ?? 0) + 1);
    }
  });
  const calls: { idx: number; name: string; sig: string; host: string; callId: string }[] = [];
  const results: { idx: number; name: string; text: string; callId: string }[] = [];
  records.forEach((r, i) => {
    const et = r.event_type ?? '';
    if (et === 'chat.tool_call') {
      const name = String(r.tool_name ?? (r.tool_call as Record<string, unknown>)?.name ?? '');
      const args = (r.tool_call as Record<string, unknown>)?.arguments ?? r.content;
      let fmtArgs = '';
      try { fmtArgs = JSON.stringify(typeof args === 'string' ? JSON.parse(args) : args, null, 2); }
      catch { fmtArgs = String(args ?? ''); }
      const cid = String((r.tool_call as Record<string, unknown>)?.tool_call_id ?? '');
      calls.push({
        idx: i, name,
        sig: extractUrlSignature(fmtArgs),
        host: extractHostSignature(fmtArgs),
        callId: cid && idCounts.get(cid) === 1 ? cid : '',
      });
    } else if (et === 'chat.tool_result') {
      results.push({ idx: i, name: r.tool_name ?? '', text: `${r.result ?? ''} ${r.content ?? ''}`, callId: r.tool_call_id ?? '' });
    }
  });

  const used = new Set<number>();
  const pair = (callIdx: number, resIdx: number) => {
    pairings.set(callIdx, {
      latency: formatLatencyS((records[resIdx]?.timestamp ?? 0) - (records[callIdx]?.timestamp ?? 0)),
      output: summarizeToolResult(records[resIdx]?.result ?? records[resIdx]?.content ?? ''),
    });
    used.add(resIdx);
  };

  const matches = (
    call: { idx: number; name: string; sig: string; host: string; callId: string },
    res: { idx: number; name: string; text: string; callId: string },
    mode: 'id' | 'url' | 'host' | 'name',
  ): boolean => {
    if (res.idx <= call.idx) return false;
    if (res.name !== call.name) return false;
    if (mode === 'id') return !!call.callId && res.callId === call.callId;
    if (mode === 'url') return !!call.sig && res.text.includes(call.sig);
    if (mode === 'host') return !!call.host && res.text.includes(call.host);
    return true;
  };

  for (const mode of ['id', 'url', 'host', 'name'] as const) {
    for (const call of calls) {
      if (pairings.has(call.idx)) continue;
      for (const res of results) {
        if (used.has(res.idx)) continue;
        if (matches(call, res, mode)) { pair(call.idx, res.idx); break; }
      }
    }
  }
  return pairings;
}

function recordToStepRow(
  rec: HistoryRecord,
  i: number,
  records: HistoryRecord[],
  nextLlmTurn: () => number,
  pairings?: Map<number, { latency: string; output: string }>,
): string | null {
  const key = rec.role === 'user' ? 'user' : (rec.event_type ?? '');

  // Only LLM calls and tool calls get rows; llm_call_start/llm_call_end,
  // tool_result (merged into its call), user, final and everything else is
  // noise here.
  if (key === 'chat.usage_metadata') {
    const turnNo = nextLlmTurn();
    const um = rec.metadata?.usage_metadata;
    const tele = um
      ? `Tokens: ${um.input_tokens?.toLocaleString() ?? '?'} in / ${um.output_tokens?.toLocaleString() ?? '?'} out${um.cache_tokens && um.cache_tokens > 0 ? `, Cache: ${um.cache_tokens.toLocaleString()} cached` : ''}`
      : '';
    // Real call duration: metadata when present (main agent), else the span
    // from the preceding llm_call_start to the following llm_call_end. A sub-
    // second span is just usage/end being written together — show nothing.
    const latency = rec.metadata?.total_latency_ms != null
      ? formatLatencyS(rec.metadata.total_latency_ms / 1000)
      : (() => {
          let startTs = 0;
          for (let j = i - 1; j >= 0; j--) {
            const rj = records[j];
            if ((rj.event_type ?? '') === 'chat.llm_call_start') { startTs = rj.timestamp ?? 0; break; }
            if (rj.role === 'user') break;
          }
          for (let j = i + 1; j < records.length; j++) {
            const rj = records[j];
            const et = rj.event_type ?? '';
            if (et === 'chat.usage_metadata' || rj.role === 'user') break;
            if (et === 'chat.llm_call_end') {
              const d = (rj.timestamp ?? 0) - startTs;
              return d >= 0.5 ? formatLatencyS(d) : '';
            }
          }
          return '';
        })();
    const input = mdTrunc(extractUserMessage(um?.prompt ?? ''), 160);
    let output = '';
    for (const r of findLLMResponseForUsage(rec, records)) {
      if ((r.event_type === 'chat.final' || r.event_type === 'chat.llm_call_end') && r.content) {
        output = r.content;
        break;
      }
    }
    if (!output) {
      // Tool-calling call: no text answer. Prefer the model's reasoning (stored
      // on the main agent's tool_call records); otherwise summarize the calls.
      const toolNames: string[] = [];
      let reasoning = '';
      for (let j = i + 1; j < records.length; j++) {
        const rj = records[j];
        const et = rj.event_type ?? '';
        if (et === 'chat.usage_metadata' || rj.role === 'user') break;
        if (et === 'chat.tool_call') {
          const nm = String(rj.tool_name ?? (rj.tool_call as Record<string, unknown>)?.name ?? '');
          if (nm) toolNames.push(nm);
          const rc = String((rj as unknown as Record<string, unknown>).reasoning_content ?? '').trim();
          if (!reasoning && rc) reasoning = rc;
        }
        if (et === 'chat.final' && rj.content) {
          output = rj.content;
          break;
        }
      }
      if (!output && reasoning) {
        output = reasoning;
      } else if (!output && toolNames.length) {
        const counts = new Map<string, number>();
        toolNames.forEach(n => counts.set(n, (counts.get(n) ?? 0) + 1));
        const parts = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
        output = parts.length > 1 ? `→ tool calls: ${parts.join(', ')}` : `→ tool call: ${parts[0]}`;
      }
    }
    return `| LLM Generation (Turn ${turnNo}) | ${mdEsc(tele)} | ${latency} | ${mdEsc(input)} | ${mdEsc(mdTrunc(output, 200))} |`;
  }

  if (key === 'chat.tool_call') {
    const name = rec.tool_name ?? (rec.tool_call as Record<string, unknown>)?.name ?? '';
    const args = (rec.tool_call as Record<string, unknown>)?.arguments ?? rec.content;
    let fmtArgs = '';
    try { fmtArgs = JSON.stringify(typeof args === 'string' ? JSON.parse(args) : args, null, 2); }
    catch { fmtArgs = String(args ?? ''); }
    const pairing = pairings?.get(i);
    const latency = pairing?.latency ?? '';
    const output = pairing?.output ?? '';
    const tele = name === 'task_tool'
      ? 'Type: Subagent Runtime Fork'
      : name === 'fetch_webpage' ? 'Protocol: HTTP GET'
      : '—';
    return `| Tool Call (\`${name}\`) | ${mdEsc(tele)} | ${latency} | ${mdEsc(mdTrunc(fmtArgs, 160))} | ${mdEsc(mdTrunc(output, 200))} |`;
  }

  return null;
}

function turnToStepByStepMarkdown(records: HistoryRecord[]): string {
  const main: HistoryRecord[] = [];
  // Group by sub-session when available (several parallel sub-agents of the
  // same type would otherwise collapse into one section); fall back to type
  // for records recorded before sub_session_id was stamped.
  const subs = new Map<string, HistoryRecord[]>();
  for (const r of records) {
    const key = r.sub_session_id ? `sid:${r.sub_session_id}` : (r.subagent_type ? `type:${r.subagent_type}` : '');
    if (!key) { main.push(r); continue; }
    const arr = subs.get(key) ?? [];
    arr.push(r);
    subs.set(key, arr);
  }
  const groups: { title: string; records: HistoryRecord[] }[] = [];
  if (main.length) groups.push({ title: 'Main Orchestrator Trace', records: main });
  let si = 1;
  for (const [key, recs] of subs) {
    const type = recs[0]?.subagent_type ?? 'subagent';
    const short = key.startsWith('sid:') ? ` (${key.slice(4).slice(-6)})` : '';
    groups.push({ title: `Subagent ${si++}: ${type} Trace${short}`, records: recs });
  }

  const lines: string[] = [];
  groups.forEach((g, gi) => {
    lines.push(`### ${gi + 1}. ${g.title}`, '');
    lines.push('| Operation | Technical Telemetry & Metrics | Latency | Input | Output |');
    lines.push('| :--- | :--- | :--- | :--- | :--- |');
    const pairings = buildToolPairings(g.records);
    let llmTurn = 0;
    for (let i = 0; i < g.records.length; i++) {
      const row = recordToStepRow(g.records[i], i, g.records, () => { llmTurn += 1; return llmTurn; }, pairings);
      if (row) lines.push(row);
    }
    lines.push('');
  });
  return lines.join('\n');
}

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <button
      title={text}
      style={{ ...btnStyle, fontSize: 11, padding: '2px 8px' }}
      onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
      {copied ? t('traceHound.copied') : t('traceHound.copy')}
    </button>
  );
}

function ErrorBanner({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div style={{ background: C.dangerSubtle, border: `1px solid ${C.dangerSubtle}`, borderRadius: 6, padding: '8px 12px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.danger }}>
      <span style={{ flex: 1 }}>{message}</span>
      <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: C.danger }}>×</button>
    </div>
  );
}

/** Find the LLM response events that correspond to a given usage_metadata record.
 *  Scans forward through the timeline to collect chat.final, chat.tool_call,
 *  chat.reasoning, chat.delta, and chat.error events until the next usage_metadata.
 */
function findLLMResponseForUsage(
  usageRec: HistoryRecord,
  allRecords: HistoryRecord[]
): HistoryRecord[] {
  if (!allRecords || allRecords.length === 0) return [];
  // id is NOT unique across events in the same turn (all assistant events share
  // request_id + ":assistant").  Use timestamp + event_type as a composite key
  // to pinpoint the exact record position.
  const usageIndex = allRecords.findIndex(
    r =>
      r.id === usageRec.id &&
      r.timestamp === usageRec.timestamp &&
      r.event_type === usageRec.event_type
  );
  if (usageIndex === -1) return [];

  const responses: HistoryRecord[] = [];
  for (let i = usageIndex + 1; i < allRecords.length; i++) {
    const r = allRecords[i];
    const et = r.event_type ?? '';
    // Stop at the next usage_metadata — that starts a new LLM call
    if (et === 'chat.usage_metadata') break;
    // Stop at user messages — they're not LLM responses
    if (r.role === 'user') break;
    // Collect response-type events. chat.llm_call_end carries the model's
    // answer and lands AFTER the usage_metadata record in history, so it must
    // be counted as a response even though the final text may also appear in
    // chat.final (which can be timestamped before the usage record).
    if (
      et === 'chat.final' ||
      et === 'chat.llm_call_end' ||
      et === 'chat.tool_call' ||
      et === 'chat.reasoning' ||
      et === 'chat.delta' ||
      et === 'chat.error'
    ) {
      responses.push(r);
    }
  }
  return responses;
}

// ── Analytics Panel ───────────────────────────────────────────────────────────

function AnalyticsPanel({ turns, isConnected, hasUsage }: { turns: TurnSummary[]; isConnected: boolean; hasUsage: boolean }) {
  const { t } = useTranslation();
  const jumpToTurn = useTraceHoundStore(s => s.jumpToTurn);
  if (turns.length === 0) return null;

  const outcomes = { completed: 0, completed_with_issues: 0, no_response: 0, error: 0, deferred: 0 };
  turns.forEach(t => { const o = t.outcome; if (o && o in outcomes) (outcomes as Record<string, number>)[o]++; });

  // Tool usage: merge tool_call names with tool results so failure counts are
  // visible per tool, and never hide a tool that had failures. Failures are
  // attributed to the acting agent (member_name / leader) when available.
  interface ToolUsage { calls: number; results: number; failed: number; byAgent: Record<string, { calls: number; failed: number }>; }
  const toolUsage: Record<string, ToolUsage> = {};
  turns.forEach(t => {
    t.tool_names.forEach(n => {
      const u = (toolUsage[n] ??= { calls: 0, results: 0, failed: 0, byAgent: {} });
      u.calls += 1;
    });
    (t.tool_results_detail ?? []).forEach(r => {
      const key = r.tool_name || '(unknown)';
      const u = (toolUsage[key] ??= { calls: 0, results: 0, failed: 0, byAgent: {} });
      u.results += 1;
      const isFail = r.failed || (typeof r.result === 'string' && r.result.includes('success=False'));
      if (isFail) u.failed += 1;
      if (r.agent) {
        const a = (u.byAgent[r.agent] ??= { calls: 0, failed: 0 });
        a.calls += 1;
        if (isFail) a.failed += 1;
      }
    });
  });
  const topTools = Object.entries(toolUsage).sort((a, b) => b[1].calls - a[1].calls).slice(0, 8);
  const extraFailedTools = Object.entries(toolUsage)
    .filter(([n, u]) => u.failed > 0 && !topTools.some(([tn]) => tn === n))
    .sort((a, b) => b[1].failed - a[1].failed);
  const displayTools = [...topTools, ...extraFailedTools];

  const skillCounts: Record<string, number> = {};
  turns.forEach(t => t.skill_names.forEach(n => { skillCounts[n] = (skillCounts[n] ?? 0) + 1; }));
  const topSkills = Object.entries(skillCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const maxTok = Math.max(...turns.map(t => t.total_tokens), 1);
  // For duration chart, only use non-retry turns (wall time is misleading for retry turns)
  const durationTurns = turns.filter(t => t.retry_count <= 1 && t.duration_seconds > 0);
  const maxDur = durationTurns.length > 0 ? Math.max(...durationTurns.map(t => t.duration_seconds)) : 0;

  let longestCascade = 0; let currentCascade = 0;
  turns.forEach(t => {
    if (t.has_error) { currentCascade++; longestCascade = Math.max(longestCascade, currentCascade); }
    else { currentCascade = 0; }
  });

  const totalRetries = turns.reduce((s, t) => s + Math.max(0, t.retry_count - 1), 0);
  const totalToolFailures = turns.reduce((s, t) => s + (t.tool_failures ?? 0), 0);

  return (
    <div style={{ marginBottom: 20, padding: '14px 16px', background: C.surfaceMuted, borderRadius: 8, border: `1px solid ${C.border}` }}>

      {/* Summary stats */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        {[
          { label: t('traceHound.stats.completed'), value: String(outcomes.completed), color: C.info, tip: t('traceHound.stats.completedTip') },
          { label: t('traceHound.stats.withProblems'), value: String(outcomes.completed_with_issues), color: outcomes.completed_with_issues > 0 ? C.warn : C.textFaint, tip: t('traceHound.stats.withProblemsTip') },
          { label: t('traceHound.stats.noResponse'), value: String(outcomes.no_response), color: outcomes.no_response > 0 ? C.violet : C.textFaint, tip: t('traceHound.stats.noResponseTip') },
          { label: t('traceHound.stats.errors'), value: String(outcomes.error), color: outcomes.error > 0 ? C.danger : C.textFaint, tip: t('traceHound.stats.errorsTip') },
          { label: t('traceHound.stats.deferred'), value: String(outcomes.deferred), color: outcomes.deferred > 0 ? C.violet : C.textFaint, tip: t('traceHound.stats.deferredTip') },
          { label: t('traceHound.stats.retries'), value: String(totalRetries), color: totalRetries > 0 ? C.warn : C.textFaint, tip: t('traceHound.stats.retriesTip') },
          { label: t('traceHound.stats.toolFailures'), value: String(totalToolFailures), color: totalToolFailures > 0 ? C.danger : C.textFaint, tip: t('traceHound.stats.toolFailuresTip') },
          ...(longestCascade >= 2 ? [{ label: t('traceHound.stats.longestStreak'), value: `${longestCascade} ${t('traceHound.stats.userMsgs')}`, color: C.danger, tip: t('traceHound.stats.longestStreakTip') }] : []),
        ].map((s, i) => (
          <Tooltip key={i} text={s.tip ?? ''}>
            <div style={{ background: C.surface, borderRadius: 6, padding: '8px 12px', border: `1px solid ${C.border}`, minWidth: 90, cursor: s.tip ? 'help' : 'default' }}>
              <div style={{ fontSize: 10, color: C.textFaint, marginBottom: 3 }}>{s.label}</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: s.color }}>{s.value}</div>
            </div>
          </Tooltip>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>

        {/* Per user message — combined quality, tokens, duration in one card */}
        <div style={{ background: C.surface, borderRadius: 6, padding: 12, border: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.text }}>{t('traceHound.stats.perUserMessage')}</div>

          {/* Outcome row */}
          <div>
            <div style={{ fontSize: 9, color: C.textFaint, marginBottom: 3, display: 'flex', justifyContent: 'space-between' }}>
              <span>{t('traceHound.stats.outcome')}</span><span>{turns.length} {t('traceHound.stats.userMsgs')}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 28 }}>
              {turns.map(tr => {
                const outcome = tr.outcome;
                const color = OUTCOME_COLORS[outcome] ?? C.textFaint;
                const pct = outcomeScore(tr);
                const h = Math.max(4, pct * 28);
                const failedCount = tr.tool_failures ?? 0;
                const failedTip = failedCount > 0 ? `\n${t('traceHound.stats.failedToolCalls', { count: failedCount })}` : '';
                return (
                  <Tooltip key={tr.turn_id} text={`${t('traceHound.stats.msgTooltip', { index: tr.turn_index + 1, text: outcomeLabel(outcome, t) })}${failedTip}\n${tr.user_content || t('traceHound.stats.noMessage')}`}>
                    <div style={{ flex: 1, minWidth: 0, height: h, background: color, borderRadius: 1, cursor: 'default', opacity: tr.outcome === 'deferred' ? 0.4 : 1, boxShadow: failedCount > 0 ? `inset 0 0 0 1px ${C.danger}` : undefined }} />
                  </Tooltip>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
              {Object.keys(OUTCOME_COLORS).map((k) => (
                <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 9, color: C.textMuted, textTransform: 'capitalize' }}>
                  <span style={{ width: 6, height: 6, borderRadius: 1, background: OUTCOME_COLORS[k], display: 'inline-block' }} />{outcomeLabel(k, t)}
                </span>
              ))}
            </div>
          </div>

          {/* Tokens row */}
          {turns.length > 0 && (
            <div>
              <div style={{ fontSize: 9, color: C.textFaint, marginBottom: 3, display: 'flex', justifyContent: 'space-between' }}>
                <span>{t('traceHound.stats.tokens')}</span>
                <span>{hasUsage ? t('traceHound.stats.countTotal', { count: turns.reduce((s, t) => s + t.total_tokens, 0).toLocaleString() }) : t('traceHound.stats.noData')}</span>
              </div>
              {hasUsage && (
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 28 }}>
                  {turns.map(tr => {
                    const h = Math.max(1, (tr.total_tokens / maxTok) * 28);
                    return (
                      <Tooltip key={tr.turn_id} text={t('traceHound.stats.tokensTooltip', { index: tr.turn_index + 1, count: tr.total_tokens.toLocaleString() })}>
                        <div style={{ flex: 1, minWidth: 0, height: h, background: tr.total_tokens > 0 ? C.violet : C.textFaint, borderRadius: 1, opacity: tr.total_tokens > 0 ? 0.65 : 0.5, cursor: 'default' }} />
                      </Tooltip>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* LLM calls row */}
          {hasUsage ? (() => {
            const maxLlm = Math.max(...turns.map(t => t.llm_call_count ?? 0), 1);
            const totalLlm = turns.reduce((s, t) => s + (t.llm_call_count ?? 0), 0);
            if (totalLlm === 0) return null;
            return (
              <div>
                <div style={{ fontSize: 9, color: C.textFaint, marginBottom: 3, display: 'flex', justifyContent: 'space-between' }}>
                  <span>{t('traceHound.stats.llmCalls')}</span><span>{t('traceHound.stats.countTotal', { count: totalLlm })}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 28 }}>
                  {turns.map(tr => {
                    const n = tr.llm_call_count ?? 0;
                    const h = Math.max(1, (n / maxLlm) * 28);
                    const color = n === 0 ? C.textFaint : n > 10 ? C.danger : n > 4 ? C.warn : C.ok;
                    return (
                      <Tooltip key={tr.turn_id} text={t('traceHound.stats.llmCallsTooltip', { index: tr.turn_index + 1, count: n })}>
                        <div style={{ flex: 1, minWidth: 0, height: h, background: color, borderRadius: 1, opacity: n === 0 ? 0.5 : 1, cursor: 'default' }} />
                      </Tooltip>
                    );
                  })}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  {([[C.ok, t('traceHound.stats.llmLegendLow')], [C.warn, t('traceHound.stats.llmLegendMid')], [C.danger, t('traceHound.stats.llmLegendHigh')]] as const).map(([c, l]) => (
                    <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 9, color: C.textMuted }}>
                      <span style={{ width: 6, height: 6, borderRadius: 1, background: c, display: 'inline-block' }} />{l}
                    </span>
                  ))}
                </div>
              </div>
            );
          })() : (
            <div>
              <div style={{ fontSize: 9, color: C.textFaint, marginBottom: 3, display: 'flex', justifyContent: 'space-between' }}>
                <span>{t('traceHound.stats.llmCalls')}</span><span>{t('traceHound.stats.noData')}</span>
              </div>
            </div>
          )}

          {/* Duration row */}
          {maxDur > 0 && (
            <div>
              <div style={{ fontSize: 9, color: C.textFaint, marginBottom: 3, display: 'flex', justifyContent: 'space-between' }}>
                <span>{t('traceHound.stats.duration')} <span style={{ fontSize: 8 }}>{t('traceHound.stats.durationSingle')}</span></span><span>{t('traceHound.stats.slowestDuration', { duration: fmtDuration(maxDur) })}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 28 }}>
                {turns.map(tr => {
                  if (tr.retry_count > 1) {
                    return (
                        <Tooltip key={tr.turn_id} text={t('traceHound.stats.retriesExcludedTooltip', { index: tr.turn_index + 1, count: tr.retry_count })}>
                          <div style={{ flex: 1, minWidth: 0, height: 4, background: C.violetSubtle, borderRadius: 1, cursor: 'default', opacity: 0.7 }} />
                        </Tooltip>
                    );
                  }
                  const pct = tr.duration_seconds / maxDur;
                  const color = tr.duration_seconds === 0 ? C.textFaint : pct > 0.75 ? C.danger : pct > 0.4 ? C.warn : C.ok;
                  const h = Math.max(1, pct * 28);
                  return (
                    <Tooltip key={tr.turn_id} text={t('traceHound.stats.durationTooltip', { index: tr.turn_index + 1, duration: fmtDuration(tr.duration_seconds) })}>
                      <div style={{ flex: 1, minWidth: 0, height: h, background: color, borderRadius: 1, opacity: tr.duration_seconds === 0 ? 0.5 : 1, cursor: 'default' }} />
                    </Tooltip>
                  );
                })}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                {([[C.ok, t('traceHound.stats.speedFast')], [C.warn, t('traceHound.stats.speedModerate')], [C.danger, t('traceHound.stats.speedSlow')]] as const).map(([c, l]) => (
                  <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 9, color: C.textMuted }}>
                    <span style={{ width: 6, height: 6, borderRadius: 1, background: c, display: 'inline-block' }} />{l}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Retries row */}
          {totalRetries > 0 && (
            <div>
              <div style={{ fontSize: 9, color: C.textFaint, marginBottom: 3, display: 'flex', justifyContent: 'space-between' }}>
                <span>{t('traceHound.stats.retriesRow')}</span><span>{t('traceHound.stats.countTotal', { count: totalRetries })}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 28 }}>
                {(() => {
                  const maxRetry = Math.max(...turns.map(t => t.retry_count), 1);
                  return turns.map(tr => {
                    const rc = tr.retry_count;
                    const pct = rc / maxRetry;
                    const color = rc === 0 ? C.borderStrong : rc === 1 ? C.textFaint : C.violet;
                    const h = Math.max(rc > 0 ? 3 : 1, pct * 28);
                    return (
                      <Tooltip key={tr.turn_id} text={t('traceHound.stats.attemptsTooltip', { index: tr.turn_index + 1, count: rc })}>
                        <div style={{ flex: 1, minWidth: 0, height: h, background: color, borderRadius: 1, cursor: 'default' }} />
                      </Tooltip>
                    );
                  });
                })()}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                {([[C.borderStrong, t('traceHound.stats.retryLegendZero')], [C.textFaint, t('traceHound.stats.retryLegendOne')], [C.violet, t('traceHound.stats.retryLegendMany')]] as const).map(([c, l]) => (
                  <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 9, color: C.textMuted }}>
                    <span style={{ width: 6, height: 6, borderRadius: 1, background: c, display: 'inline-block' }} />{l}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Tools per user message */}
          {(() => {
            const maxTools = Math.max(...turns.map(t => t.tool_names.length), 0);
            const totalTools = turns.reduce((s, t) => s + t.tool_names.length, 0);
            if (maxTools === 0) return null;
            return (
              <div>
                <div style={{ fontSize: 9, color: C.textFaint, marginBottom: 3, display: 'flex', justifyContent: 'space-between' }}>
                  <span>{t('traceHound.stats.toolsPerMsg')}</span><span>{t('traceHound.stats.countTotal', { count: totalTools })}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 28 }}>
                  {turns.map(tr => {
                    const n = tr.tool_names.length;
                    const h = Math.max(1, (n / maxTools) * 28);
                    const names = n > 0 ? `\n${tr.tool_names.slice(0, 5).join(', ')}${tr.tool_names.length > 5 ? '…' : ''}` : '';
                    return (
                      <Tooltip key={tr.turn_id} text={`${t('traceHound.stats.toolsTooltip', { index: tr.turn_index + 1, count: n })}${names}`}>
                        <div style={{ flex: 1, minWidth: 0, height: h, background: n === 0 ? C.textFaint : C.warn, borderRadius: 1, cursor: 'default', opacity: n === 0 ? 0.5 : 0.8 }} />
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* Skills per user message */}
          {(() => {
            const maxSkills = Math.max(...turns.map(t => t.skill_names.length), 0);
            const totalSkills = turns.reduce((s, t) => s + t.skill_names.length, 0);
            if (maxSkills === 0) return null;
            return (
              <div>
                <div style={{ fontSize: 9, color: C.textFaint, marginBottom: 3, display: 'flex', justifyContent: 'space-between' }}>
                  <span>{t('traceHound.stats.skillsPerMsg')}</span><span>{t('traceHound.stats.countTotal', { count: totalSkills })}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 28 }}>
                  {turns.map(tr => {
                    const n = tr.skill_names.length;
                    const h = Math.max(1, (n / maxSkills) * 28);
                    const names = n > 0 ? `\n${tr.skill_names.join(', ')}` : '';
                    return (
                      <Tooltip key={tr.turn_id} text={`${t('traceHound.stats.skillsTooltip', { index: tr.turn_index + 1, count: n })}${names}`}>
                        <div style={{ flex: 1, minWidth: 0, height: h, background: n === 0 ? C.textFaint : C.violet, borderRadius: 1, cursor: 'default', opacity: n === 0 ? 0.5 : 0.8 }} />
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>

        {/* Tool frequency */}
        {displayTools.length > 0 && (
          <div style={{ background: C.surface, borderRadius: 6, padding: 12, border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t('traceHound.stats.toolUsage')}</div>
            {displayTools.map(([tool, u]) => {
              const failedAgents = Object.entries(u.byAgent).filter(([, a]) => a.failed > 0);
              const firstFail = turns
                .flatMap(t => (t.tool_results_detail ?? []).map(r => ({ turnId: t.turn_id, r })))
                .find(x => x.r.tool_name === tool && (x.r.failed || (x.r.result ?? '').includes('success=False')));
              return (
                <div
                  key={tool}
                  style={{ marginBottom: 5, cursor: u.failed > 0 ? 'pointer' : 'default' }}
                  title={u.failed > 0 ? t('traceHound.stats.jumpToFailure') : undefined}
                  onClick={() => {
                    if (u.failed > 0 && firstFail && isConnected) {
                      jumpToTurn(firstFail.turnId, firstFail.r.tool_call_id);
                    }
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
                    <span style={{ color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '52%' }}>🔧 {tool}</span>
                    <span style={{ color: u.failed > 0 ? C.danger : C.textMuted, flexShrink: 0, whiteSpace: 'nowrap' }}>
                      {u.failed > 0 ? t('traceHound.stats.callCountFailed', { count: u.calls, failed: u.failed }) : t('traceHound.stats.callCount', { count: u.calls })}
                    </span>
                  </div>
                  <div style={{ height: 3, background: C.border, borderRadius: 2, marginBottom: 2 }}>
                    <div style={{ height: 3, width: `${(u.calls / displayTools[0][1].calls) * 100}%`, background: u.failed > 0 ? C.danger : C.warn, borderRadius: 2 }} />
                  </div>
                  {failedAgents.length > 0 && (
                    <div style={{ fontSize: 10, color: C.danger, marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t('traceHound.stats.failedBy', { agents: failedAgents.map(([name]) => name === 'leader' ? t('traceHound.perAgent.leader') : name).join(' · ') })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Per-agent activity (team mode) — merged across turns by agent name */}
        {(() => {
          const teamTurns = turns.filter(t => (t.agent_activity?.length ?? 0) > 0);
          if (teamTurns.length === 0) return null;
          if (teamTurns.length === 1) return <PerAgentCard turn={teamTurns[0]} />;
          const merged = new Map<string, AgentActivity>();
          for (const t of teamTurns) {
            for (const a of t.agent_activity ?? []) {
              const cur = merged.get(a.name);
              if (cur) {
                cur.tool_calls += a.tool_calls;
                cur.tool_results += a.tool_results;
                cur.tool_failures += a.tool_failures;
                cur.responses += a.responses;
                cur.llm_calls += a.llm_calls;
                cur.tokens += a.tokens;
                cur.cost += a.cost;
                if (cur.role !== 'leader' && a.role === 'leader') cur.role = 'leader';
              } else {
                merged.set(a.name, { ...a });
              }
            }
          }
          const aggregated: TurnSummary = { ...teamTurns[0], agent_activity: [...merged.values()] };
          return <PerAgentCard turn={aggregated} />;
        })()}

        {/* Skill frequency */}
        {topSkills.length > 0 && (
          <div style={{ background: C.surface, borderRadius: 6, padding: 12, border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t('traceHound.stats.skillUsage')}</div>
            {topSkills.map(([skill, count]) => (
              <div key={skill} style={{ marginBottom: 5 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
                  <span style={{ color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '78%' }}>🎯 {skill}</span>
                  <span style={{ color: C.textMuted, flexShrink: 0 }}>{t('traceHound.stats.errCount', { count })}</span>
                </div>
                <div style={{ height: 3, background: C.border, borderRadius: 2 }}>
                  <div style={{ height: 3, width: `${(count / topSkills[0][1]) * 100}%`, background: C.violet, borderRadius: 2 }} />
                </div>
              </div>
            ))}
          </div>
        )}

      </div>
    </div>
  );
}

// ── LLM Analysis Panel ────────────────────────────────────────────────────────

const PRIORITY_COLORS: Record<number, { bg: string; border: string; text: string; label: string }> = {
  1: { bg: C.dangerSubtle, border: C.dangerSubtle, text: C.danger, label: 'P1' },
  2: { bg: C.warnSubtle, border: C.warnSubtle, text: C.warn, label: 'P2' },
  3: { bg: C.warnSubtle, border: C.warnSubtle, text: C.warn, label: 'P3' },
  4: { bg: C.infoSubtle, border: C.infoSubtle, text: C.info, label: 'P4' },
  5: { bg: C.surfaceMuted, border: C.borderStrong, text: C.textMuted, label: 'P5' },
};

/** Splits "1) ... 2) ..." recommendation text into styled numbered rows.
 *  Handles both multi-line lists and single-line semicolon-separated lists.
 */
function RecommendationList({ text }: { text: string }) {
  // Try to detect numbered items. Supports:
  //   1) ... 2) ...   (inline or multiline)
  //   1. ... 2. ...
  //   (1) ... (2) ...
  //   separated by newlines or by "; " + number pattern
  const items: { num: number; body: string }[] = [];

  // First, try inline pattern: split on "; " followed by a number marker
  // This handles: "1) foo; 2) bar; 3) baz"
  const inlineSplit = text.split(/;\s*(?=(?:\d+[\.)]|\(\d+\))\s)/);

  const processChunk = (chunk: string) => {
    const m = chunk.match(/^(?:(\d+)[\.)]\s*|\((\d+)\)\s*)/);
    if (!m) return null;
    const num = parseInt(m[1] ?? m[2], 10);
    const body = chunk.slice(m[0].length).trim();
    return { num, body };
  };

  for (const chunk of inlineSplit) {
    // A chunk may itself contain newlines; split those too
    const lines = chunk.split(/\n+/).map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const parsed = processChunk(line);
      if (parsed) {
        items.push(parsed);
      } else if (items.length > 0) {
        // Continuation line for the previous item
        items[items.length - 1].body += ' ' + line;
      } else {
        // Preamble before any numbered item — create a pseudo-item
        items.push({ num: 0, body: line });
      }
    }
  }

  // Fallback: if no numbered items found, render as plain prose
  if (items.length === 0 || (items.length === 1 && items[0].num === 0)) {
    return (
      <div style={{ fontSize: 13, color: C.ok, padding: '9px 11px', whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>
        {text}
      </div>
    );
  }

  return (
    <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map((item) => (
        <div key={item.num} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span style={{
            flexShrink: 0,
            fontSize: 11, fontWeight: 700, color: C.ok,
            background: C.okSubtle, borderRadius: '50%',
            width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
            marginTop: 1,
          }}>
            {item.num}
          </span>
          <span style={{ fontSize: 13, color: C.ok, lineHeight: 1.55, paddingTop: 2 }}>
            {item.body}
          </span>
        </div>
      ))}
    </div>
  );
}

function IssueCard({ issue }: { issue: AnalysisIssue }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const p = Math.min(5, Math.max(1, issue.priority ?? 5));
  const pc = PRIORITY_COLORS[p];

  return (
    <div style={{ border: `1px solid ${pc.border}`, borderLeft: `3px solid ${pc.text}`, borderRadius: 6, marginBottom: 8, background: C.surface, overflow: 'hidden' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', cursor: 'pointer', background: pc.bg }}
        onClick={() => setExpanded(x => !x)}
      >
        <span style={{ fontSize: 11, fontWeight: 800, padding: '2px 7px', borderRadius: 4, background: pc.bg, color: pc.text, border: `1px solid ${pc.border}`, flexShrink: 0 }}>
          {pc.label}
        </span>
        <span style={{ fontWeight: 600, fontSize: 13, color: C.text, flex: 1 }}>{issue.title}</span>
        <span style={{ fontSize: 12, color: C.textFaint, flexShrink: 0 }}>{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div style={{ padding: '14px 16px', borderTop: `1px solid ${pc.border}`, display: 'flex', flexDirection: 'column', gap: 14, background: C.surface }}>
          {/* Description — most prominent narrative block */}
          {issue.description && (
            <div style={{ color: C.text, fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
              {issue.description}
            </div>
          )}

          {/* Evidence — visually distinct raw-data / log card */}
          {issue.evidence && (
            <div style={{ background: C.surfaceMuted, border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', background: C.border, fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <span>🧾</span> {t('traceHound.diagnosis.evidence')}
              </div>
              <div style={{ fontSize: 12, color: C.text, padding: '8px 10px', whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', lineHeight: 1.45 }}>
                {issue.evidence}
              </div>
            </div>
          )}

          {/* Impact + Root Cause — side-by-side when both present, stacked otherwise */}
          <div style={{ display: 'flex', flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
            {issue.impact && (
              <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5 }}>
                  <span style={{ fontSize: 12 }}>⚠️</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: C.warn, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{t('traceHound.diagnosis.impact')}</span>
                </div>
                <div style={{ fontSize: 12.5, color: C.warn, background: C.warnSubtle, border: `1px solid ${C.warnSubtle}`, borderRadius: 5, padding: '7px 9px', lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
                  {issue.impact}
                </div>
              </div>
            )}
            {issue.root_cause && (
              <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5 }}>
                  <span style={{ fontSize: 12 }}>🔍</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: C.violet, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{t('traceHound.diagnosis.rootCause')}</span>
                </div>
                <div style={{ fontSize: 12.5, color: C.violet, background: C.violetSubtle, border: `1px solid ${C.violetSubtle}`, borderRadius: 5, padding: '7px 9px', lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
                  {issue.root_cause}
                </div>
              </div>
            )}
          </div>

          {/* Recommendation — most visually prominent, actionable */}
          {issue.recommendation && (
            <div style={{ background: C.okSubtle, border: `1px solid ${C.okSubtle}`, borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: C.okSubtle, fontSize: 10, fontWeight: 700, color: C.ok, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <span>💡</span> {t('traceHound.diagnosis.recommendation')}
              </div>
              <RecommendationList text={issue.recommendation} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Turn List ─────────────────────────────────────────────────────────────────

export function TurnListView({ isConnected, embedded = false }: { isConnected: boolean; embedded?: boolean }) {
  const { t } = useTranslation();
  const {
    selectedSession, turns, sessionStats, loading, error, selectTurn, back, clearError,
    analysis, analyzing, analyzeError, analyzeSession, clearAnalyzeError,
  } = useTraceHoundStore();
  const [outcomeFilters, setOutcomeFilters] = useState<Set<string>>(new Set());
  const [filterRetries, setFilterRetries] = useState(false);
  const [filterSlow, setFilterSlow] = useState(false);

  // A legacy session with no persisted usage shows "—" for LLM/token figures
  // rather than a misleading "0".
  const hasUsage = turns.some(t => (t.llm_call_count ?? 0) > 0 || t.total_tokens > 0);

  // p90 threshold for slow user messages (only from non-retry — wall time is misleading)
  const p90dur = useMemo(() => {
    const sorted = [...turns].filter(t => t.retry_count <= 1).map(t => t.duration_seconds).filter(d => d > 0).sort((a, b) => a - b);
    if (!sorted.length) return 0;
    return sorted[Math.floor(sorted.length * 0.9)] ?? sorted[sorted.length - 1];
  }, [turns]);

  const visibleTurns = useMemo(() => turns.filter(t => {
    if (outcomeFilters.size > 0 && !outcomeFilters.has(t.outcome)) return false;
    if (filterRetries && t.retry_count <= 1) return false;
    if (filterSlow && (t.retry_count > 1 || t.duration_seconds <= p90dur)) return false;
    return true;
  }), [turns, outcomeFilters, filterRetries, filterSlow, p90dur]);

  const anyFilter = outcomeFilters.size > 0 || filterRetries || filterSlow;

  const [analyticsOpen, setAnalyticsOpen] = useState(true);
  const [messagesOpen, setMessagesOpen] = useState(true);

  const [analysisOpen, setAnalysisOpen] = useState(!!analysis);

  // Compute quick summaries for section headers
  const statsSummary = useMemo(() => {
    const completed = turns.filter(t => t.outcome === 'completed').length;
    const withIssues = turns.filter(t => t.outcome === 'completed_with_issues').length;
    const errors = turns.filter(t => t.outcome === 'error').length;
    const noResp = turns.filter(t => t.outcome === 'no_response').length;
    const deferred = turns.filter(t => t.outcome === 'deferred').length;
    const retryCount = turns.filter(t => t.retry_count > 1).length;
    const totalTools = turns.reduce((s, t) => s + t.tool_names.length, 0);
    const totalSkills = new Set(turns.flatMap(t => t.skill_names)).size;
    return { completed, withIssues, errors, noResp, deferred, retryCount, totalTools, totalSkills };
  }, [turns]);

  return (
    <div style={panelStyle}>
      {/* 1. Header — title left, metadata right */}
      <div style={headerStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            {!embedded && <button style={btnStyle} onClick={back}>{t('traceHound.back')}</button>}
            <h2 style={{ ...titleStyle, marginBottom: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {modeBadge(selectedSession?.mode)}{selectedSession?.title ?? selectedSession?.session_id}
            </h2>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-end', flexShrink: 0 }}>
          {/* Row 1: session id, date, copy button */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 11, color: C.textFaint }}>
            <span>{selectedSession?.session_id}</span>
            {sessionStats?.date_range && <span>{sessionStats.date_range}</span>}
            {sessionStats?.history_file_path && (
              <Tooltip text={sessionStats.history_file_path}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'help' }}>
                  <span>📁</span>
                  <CopyButton text={sessionStats.history_file_path} />
                </span>
              </Tooltip>
            )}
          </div>
          {/* Row 2: user msgs · llm calls · events · tokens · costs · latencies · models · context */}
          {sessionStats && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: 12, color: C.textMuted, marginTop: 6 }}>
              <span><strong style={{ color: C.text }}>{sessionStats.total_turns}</strong> {t('traceHound.header.userMsgs')}</span>
              <span><strong style={{ color: C.text }}>{hasUsage ? (sessionStats.total_llm_calls ?? 0) : t('traceHound.stats.noData')}</strong> {t('traceHound.header.llmCalls')}</span>
              <span><strong style={{ color: C.text }}>{sessionStats.total_events ?? selectedSession?.message_count ?? 0}</strong> {t('traceHound.header.events')}</span>
              <span><strong style={{ color: C.text }}>{hasUsage ? (sessionStats.total_tokens ?? 0).toLocaleString() : t('traceHound.stats.noData')}</strong> {t('traceHound.header.tokens')}</span>
              {(sessionStats.total_cache_tokens ?? 0) > 0 && (
                <span>🔄 <strong style={{ color: C.text }}>{sessionStats.total_cache_tokens?.toLocaleString()}</strong> {t('traceHound.header.cache')}</span>
              )}
              {sessionStats.error_count > 0 && (
                <span style={{ color: C.danger }}><strong>{sessionStats.error_count}</strong> {t('traceHound.header.withErrors')}</span>
              )}
              {(sessionStats.total_cost ?? 0) > 0 && (
                <span>💰 <strong style={{ color: C.text }}>${sessionStats.total_cost?.toFixed(4)}</strong></span>
              )}
              {(sessionStats.avg_total_latency_ms ?? 0) > 0 && (
                <Tooltip text={t('traceHound.header.avgLatencyTooltip', { ttft: (sessionStats.avg_ttft_ms ?? 0).toFixed(0), tpot: (sessionStats.avg_tpot_ms ?? 0).toFixed(1) })}>
                  <span style={{ cursor: 'help' }}>⏱️ <strong style={{ color: C.text }}>{((sessionStats.avg_total_latency_ms ?? 0) / 1000).toFixed(1)}s</strong> {t('traceHound.header.avgLatency')}</span>
                </Tooltip>
              )}
              {(sessionStats.max_context_usage_percent ?? 0) > 0 && (
                <Tooltip text={t('traceHound.header.maxContextTooltip')}>
                  <span style={{ cursor: 'help', color: (sessionStats.max_context_usage_percent ?? 0) > 80 ? C.danger : C.textMuted }}>
                    📏 <strong style={{ color: (sessionStats.max_context_usage_percent ?? 0) > 80 ? C.danger : C.text }}>{sessionStats.max_context_usage_percent?.toFixed(1)}%</strong> {t('traceHound.header.context')}
                  </span>
                </Tooltip>
              )}
              {sessionStats.channel_id && (
                <span>📡 <strong style={{ color: C.text }}>{sessionStats.channel_id}</strong></span>
              )}
              {sessionStats.models_used && sessionStats.models_used.length > 0 && (
                <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  🧠 {sessionStats.models_used.map(m => (
                    <span key={m} style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: C.surfaceMuted, color: C.text }}>{m}</span>
                  ))}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {error && <ErrorBanner message={error} onClose={clearError} />}
      {analyzeError && <ErrorBanner message={`${t('traceHound.diagnosis.title')}: ${analyzeError}`} onClose={clearAnalyzeError} />}

      {/* Highlights strip — deterministic signals from session data (no LLM) */}
      {!loading && (() => { const hs = buildHighlights(turns); return hs.length > 0 ? (
        <div data-testid="tracehound-highlights" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          {hs.map(h => {
            const label = t(`traceHound.highlights.${h.labelKey}`, h.labelParams);
            return (
              <button key={h.id} style={{
                display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer',
                padding: '5px 10px', borderRadius: 8, border: `1px solid ${C.border}`,
                background: C.surface, color: C.textMuted,
              }} onClick={() => isConnected && selectTurn(h.turnIds[0])} title={label}>
                <span>{h.icon}</span><span>{label}</span>
              </button>
            );
          })}
        </div>
      ) : null; })()}

      {/* 2. Diagnosis — LLM-powered analysis */}
      <div style={{ marginBottom: 20, border: `1px solid ${C.violetSubtle}`, borderRadius: 8, background: C.violetSubtle, overflow: 'hidden' }}>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: C.violetSubtle, borderBottom: analysisOpen ? `1px solid ${C.violetSubtle}` : 'none', cursor: 'pointer' }}
          onClick={() => setAnalysisOpen(x => !x)}
        >
          <span style={{ fontSize: 15 }}>🔬</span>
          <span style={{ fontWeight: 700, fontSize: 13, color: C.violet }}>
            {t('traceHound.diagnosis.title')}
            {analysis && (
              <span style={{ fontSize: 11, fontWeight: 400, color: C.violet, marginLeft: 8 }}>
                {t('traceHound.diagnosis.issueCount', { count: analysis.issues.length })}
                {' · '}
                {new Date(analysis.analyzed_at * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
            {!analysis && !analyzing && (
              <span style={{ fontSize: 11, fontWeight: 400, color: C.textFaint, marginLeft: 8 }}>
                {t('traceHound.diagnosis.none')}
              </span>
            )}
            {analyzing && (
              <span style={{ fontSize: 11, fontWeight: 400, color: C.violet, marginLeft: 8 }}>
                {t('traceHound.diagnosis.running')}
              </span>
            )}
          </span>
          {/* Right side: LLM disclaimer only */}
          <span style={{ flex: 1, fontSize: 11, color: C.textFaint, textAlign: 'right', paddingRight: 4 }}>
            {t('traceHound.diagnosis.disclaimer')}
          </span>
          {analysis && sessionStats?.session_fingerprint && analysis.fingerprint !== sessionStats.session_fingerprint && (
            <Tooltip text={t('traceHound.diagnosis.staleTooltip')}>
              <span style={{ fontSize: 11, fontWeight: 700, padding: '1px 7px', borderRadius: 4, background: C.warnSubtle, color: C.warn, border: `1px solid ${C.warnSubtle}`, cursor: 'help' }}>{t('traceHound.diagnosis.stale')}</span>
            </Tooltip>
          )}
          <Tooltip text={analysis ? t('traceHound.diagnosis.rerunTooltip') : t('traceHound.diagnosis.runTooltip')}>
            <button
              style={{ ...btnStyle, fontSize: 11, background: analyzing ? C.violetSubtle : C.violet, color: analyzing ? C.violet : C.surface, border: `1px solid ${C.violet}`, padding: '3px 10px', cursor: analyzing ? 'not-allowed' : 'pointer' }}
              onClick={e => { e.stopPropagation(); analyzeSession(); }}
              disabled={analyzing || !isConnected}
            >
              {analyzing ? '…' : analysis ? t('traceHound.diagnosis.rerun') : t('traceHound.diagnosis.diagnose')}
            </button>
          </Tooltip>
          <span style={{ fontSize: 12, color: C.violet }}>{analysisOpen ? '▲' : '▼'}</span>
        </div>
        {analysisOpen && (
          <div style={{ padding: '12px 14px' }}>
            {analyzing && (
              <div style={{ padding: '10px 0', fontSize: 13, color: C.violet, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 18 }}>🔬</span>
                <span>{t('traceHound.diagnosis.sending')}</span>
              </div>
            )}
            {!analyzing && !analysis && (
              <div style={{ color: C.textFaint, fontSize: 12, padding: '4px 0' }}>
                {t('traceHound.diagnosis.empty', { diagnose: t('traceHound.diagnosis.diagnose') })}
              </div>
            )}
            {!analyzing && analysis && (
              <>
                {analysis.issues.length === 0 ? (
                  <div style={{ textAlign: 'center', color: C.textMuted, fontSize: 13, padding: '20px 0' }}>{t('traceHound.diagnosis.healthy')}</div>
                ) : (
                  [...analysis.issues]
                    .sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5))
                    .map((issue, i) => <IssueCard key={i} issue={issue} />)
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* 3. Stats — local data summary (charts, counts, distributions) */}
      {!loading && turns.length > 0 && (
        <div style={{ marginBottom: 20, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: C.surfaceMuted, borderBottom: analyticsOpen ? `1px solid ${C.border}` : 'none', cursor: 'pointer' }}
            onClick={() => setAnalyticsOpen(x => !x)}
          >
            <span style={{ fontSize: 14 }}>📊</span>
            <span style={{ fontWeight: 700, fontSize: 13, color: C.text }}>
              {t('traceHound.stats.title')}
              <span style={{ fontSize: 11, fontWeight: 400, color: C.textMuted, marginLeft: 8 }}>
                {[
                  t('traceHound.stats.summaryCompleted', { count: statsSummary.completed }),
                  t('traceHound.stats.summaryWithProblems', { count: statsSummary.withIssues }),
                  t('traceHound.stats.summaryNoResponse', { count: statsSummary.noResp }),
                  t('traceHound.stats.summaryErrors', { count: statsSummary.errors }),
                  ...(statsSummary.deferred > 0 ? [t('traceHound.stats.summaryDeferred', { count: statsSummary.deferred })] : []),
                  t('traceHound.stats.summaryToolCalls', { count: statsSummary.totalTools }),
                  ...(statsSummary.totalSkills > 0 ? [t('traceHound.stats.summarySkills', { count: statsSummary.totalSkills })] : []),
                ].join(' · ')}
              </span>
            </span>
            <span style={{ flex: 1, fontSize: 11, color: C.textFaint, textAlign: 'right', paddingRight: 4 }}>{t('traceHound.stats.fromData')}</span>
            <span style={{ fontSize: 11, color: C.textFaint }}>{analyticsOpen ? '▲' : '▼'}</span>
          </div>
          {analyticsOpen && <AnalyticsPanel turns={turns} isConnected={isConnected} hasUsage={hasUsage} />}
        </div>
      )}

      {/* 4. User messages — turn-by-turn list */}
      {turns.length > 0 && (
        <div style={{ marginBottom: 20, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: C.surfaceMuted, borderBottom: messagesOpen ? `1px solid ${C.border}` : 'none', cursor: 'pointer' }}
            onClick={() => setMessagesOpen(x => !x)}
          >
            <span style={{ fontSize: 14 }}>💬</span>
            <span style={{ fontWeight: 700, fontSize: 13, color: C.text }}>{t('traceHound.messages.title')}</span>
            <span style={{ flex: 1, fontSize: 11, color: C.textMuted, textAlign: 'right', paddingRight: 4 }}>
              {t('traceHound.messages.shown', { shown: visibleTurns.length, total: turns.length })}{anyFilter ? ` ${t('traceHound.messages.filtered')}` : ''}
            </span>
            <span style={{ fontSize: 11, color: C.textFaint, paddingRight: 4 }}>{t('traceHound.messages.log')}</span>
            <span style={{ fontSize: 11, color: C.textFaint }}>{messagesOpen ? '▲' : '▼'}</span>
          </div>
          {messagesOpen && (
            <div style={{ padding: '12px 14px' }}>
              {/* Filter bar */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
                {/* Outcome filters */}
                {([
                  { key: 'completed_with_issues', label: t('traceHound.messages.withProblems'), icon: '⚠', count: statsSummary.withIssues, color: C.warn },
                  { key: 'no_response', label: t('traceHound.messages.noResponse'), icon: '❓', count: statsSummary.noResp, color: C.violet },
                  { key: 'error', label: t('traceHound.messages.errors'), icon: '❌', count: statsSummary.errors, color: C.danger },
                  { key: 'deferred', label: t('traceHound.messages.deferred'), icon: '⏸', count: statsSummary.deferred, color: C.violet },
                ] as const).map((f) => {
                  const active = outcomeFilters.has(f.key);
                  return (
                    <button key={f.key} onClick={(e) => {
                      e.stopPropagation();
                      setOutcomeFilters(prev => {
                        const next = new Set(prev);
                        if (next.has(f.key)) next.delete(f.key);
                        else next.add(f.key);
                        return next;
                      });
                    }} style={{
                      fontSize: 11, padding: '3px 10px', borderRadius: 12,
                      border: `1px solid ${active ? f.color : C.border}`,
                      background: C.surfaceMuted,
                      color: active ? f.color : C.textMuted,
                      cursor: 'pointer', fontWeight: active ? 600 : 400,
                    }}>{f.icon} {f.label}{f.count > 0 ? ` ${f.count}` : ''}</button>
                  );
                })}
                {/* Separator */}
                <span style={{ color: C.border, fontSize: 14, userSelect: 'none' }}>|</span>
                {/* Behavioral filters */}
                <button onClick={(e) => { e.stopPropagation(); setFilterRetries(x => !x); }} style={{
                  fontSize: 11, padding: '3px 10px', borderRadius: 12,
                  border: `1px solid ${filterRetries ? C.info : C.border}`,
                  background: filterRetries ? C.infoSubtle : C.surfaceMuted,
                  color: filterRetries ? C.info : C.textMuted,
                  cursor: 'pointer', fontWeight: filterRetries ? 600 : 400,
                }}>🔁 {t('traceHound.messages.withRetries')}{statsSummary.retryCount > 0 ? ` ${statsSummary.retryCount}` : ''}</button>
                <Tooltip text={`${t('traceHound.messages.slowTooltip')}${p90dur > 0 ? ` ${t('traceHound.messages.slowThreshold', { duration: fmtDuration(p90dur) })}` : ''}`}>
                  <button onClick={(e) => { e.stopPropagation(); setFilterSlow(x => !x); }} style={{
                    fontSize: 11, padding: '3px 10px', borderRadius: 12,
                    border: `1px solid ${filterSlow ? C.violet : C.border}`,
                    background: filterSlow ? C.violetSubtle : C.surfaceMuted,
                    color: filterSlow ? C.violet : C.textMuted,
                    cursor: 'pointer', fontWeight: filterSlow ? 600 : 400,
                  }}>⏱ {t('traceHound.messages.slow')}</button>
                </Tooltip>
                {anyFilter && (
                  <button onClick={(e) => { e.stopPropagation(); setOutcomeFilters(new Set()); setFilterRetries(false); setFilterSlow(false); }}
                    style={{ fontSize: 11, padding: '3px 10px', borderRadius: 12, border: `1px solid ${C.border}`, background: C.surface, color: C.textMuted, cursor: 'pointer' }}
                  >{t('traceHound.messages.reset')}</button>
                )}
                {anyFilter && <span style={{ fontSize: 11, color: C.textFaint }}>{visibleTurns.length}/{turns.length}</span>}
              </div>

              {loading && <div style={emptyStyle}>{t('traceHound.messages.loading')}</div>}
              {!loading && turns.length === 0 && <div style={emptyStyle}>{t('traceHound.messages.noMessages')}</div>}
              {!loading && visibleTurns.length === 0 && <div style={emptyStyle}>{t('traceHound.messages.noMatch')}</div>}

              {visibleTurns.map((turn) => {
                const isSlow = p90dur > 0 && turn.retry_count <= 1 && turn.duration_seconds > p90dur;
                const isDeferred = turn.was_deferred;
                return (
                  <div key={turn.turn_id}
                    style={{ ...cardStyle, borderLeftWidth: (turn.has_error || isDeferred) ? 3 : 1, borderLeftColor: isDeferred ? C.violetSubtle : turn.has_error ? C.dangerSubtle : C.border, opacity: isDeferred ? 0.75 : 1 }}
                    onMouseEnter={e => (e.currentTarget.style.borderColor = C.violet)}
                    onMouseLeave={e => (e.currentTarget.style.borderColor = isDeferred ? C.violetSubtle : turn.has_error ? C.dangerSubtle : C.border)}
                    onClick={() => isConnected && selectTurn(turn.turn_id)}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {/* Row 1: badges */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: C.violet, background: C.violetSubtle, borderRadius: 4, padding: '1px 6px', flexShrink: 0 }}>#{turn.turn_index + 1}</span>
                          {modeBadge(turn.mode)}
                          {turn.agents && turn.agents.length > 0 && turn.agents.map(name => {
                            const act = turn.agent_activity?.find(a => a.name === name);
                            const tip = act
                              ? t('traceHound.messages.agentTooltip', {
                                  name,
                                  leader: act.role === 'leader' ? ` (${t('traceHound.perAgent.leader')})` : '',
                                  tools: act.tool_calls,
                                  failed: act.tool_failures,
                                  responses: act.responses,
                                })
                              : name;
                            return (
                              <Tooltip key={name} text={tip}>
                                {agentTag(name, t, false)}
                              </Tooltip>
                            );
                          })}
                          <OutcomeBadge outcome={turn.outcome} issues={turn.issues} t={t} />
                          {queryTypeBadge(turn.query_type)}
                          {turn.has_error && !isDeferred && (
                            <span style={{ fontSize: 11, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: C.dangerSubtle, color: C.danger, border: `1px solid ${C.dangerSubtle}` }}>
                              ⚠ {turn.error_category ?? t('traceHound.messages.issueFallback')}
                            </span>
                          )}
                          {isDeferred && (
                            <Tooltip text={t('traceHound.messages.neverProcessedTooltip')}>
                              <span style={{ fontSize: 11, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: C.violetSubtle, color: C.violet, border: `1px solid ${C.violetSubtle}`, cursor: 'help' }}>
                                ⏸ {t('traceHound.messages.neverProcessed')}
                              </span>
                            </Tooltip>
                          )}
                          {turn.retry_count > 1 && (
                            <Tooltip text={t('traceHound.messages.retriesTooltip', { count: turn.retry_count })}>
                              <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: C.warnSubtle, color: C.warn, border: `1px solid ${C.warnSubtle}`, cursor: 'help' }}>
                                {turn.retry_count} {t('traceHound.messages.attempts')}
                              </span>
                            </Tooltip>
                          )}
                        </div>
                        {/* Row 2: user message */}
                        <div style={{ fontSize: 13, color: turn.user_content ? C.text : C.textFaint, fontStyle: turn.user_content ? 'normal' : 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {turn.user_content || t('traceHound.messages.noUserMessage')}
                        </div>
                        {/* Row 3: tool/file/skill badges */}
                        {(turn.tool_names.length > 0 || turn.skill_names.length > 0 || turn.tool_failures > 0 || turn.file_count > 0) && (
                          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                            {turn.tool_names.slice(0, 3).map((t, i) => (
                              <span key={i} style={{ fontSize: 11, padding: '1px 7px', borderRadius: 3, background: C.surfaceMuted, color: C.text, border: `1px solid ${C.border}` }}>🔧 {t}</span>
                            ))}
                            {turn.tool_names.length > 3 && <span style={{ fontSize: 11, color: C.textMuted }}>{t('traceHound.messages.more', { count: turn.tool_names.length - 3 })}</span>}
                            {turn.skill_names.slice(0, 2).map((s, i) => (
                              <span key={`sk-${i}`} style={{ fontSize: 11, padding: '1px 7px', borderRadius: 3, background: C.violetSubtle, color: C.violet, border: `1px solid ${C.violetSubtle}` }}>🎯 {s}</span>
                            ))}
                            {turn.skill_names.length > 2 && <span style={{ fontSize: 11, color: C.textMuted }}>{t('traceHound.messages.more', { count: turn.skill_names.length - 2 })}</span>}
                            {turn.tool_failures > 0 && <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 3, background: C.dangerSubtle, color: C.danger, border: `1px solid ${C.dangerSubtle}` }}>{turn.tool_failures} {t('traceHound.messages.failed')}</span>}
                            {turn.file_count > 0 && <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 3, background: C.okSubtle, color: C.ok, border: `1px solid ${C.okSubtle}` }}>{t('traceHound.messages.fileCount', { count: turn.file_count })}</span>}
                          </div>
                        )}
                      </div>
                      {/* Right: time / duration / tokens / models / latency / context / cost */}
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <Tooltip text={fmtDateTime(turn.timestamp)}>
                          <div style={{ fontSize: 12, color: C.textMuted, cursor: 'default' }}>{fmtTime(turn.timestamp)}</div>
                        </Tooltip>
                        {/* Duration: only show for non-retry turns — wall time is misleading for retried turns */}
                        {turn.duration_seconds > 0 && turn.retry_count <= 1 && (
                          <div style={{ fontSize: 11, marginTop: 2, color: isSlow ? C.warn : C.textFaint, fontWeight: isSlow ? 600 : 400 }}>
                            {fmtDuration(turn.duration_seconds)}
                          </div>
                        )}
                        {(turn.llm_call_count ?? 0) > 0 && (
                          <div style={{ fontSize: 11, color: C.textFaint, marginTop: 1 }}>{t('traceHound.messages.llmCalls', { count: turn.llm_call_count })}</div>
                        )}
                        {turn.total_tokens > 0 && <div style={{ fontSize: 11, color: C.textFaint, marginTop: 1 }}>{t('traceHound.messages.tokens', { count: turn.total_tokens.toLocaleString() })}</div>}
                        {(turn.avg_total_latency_ms ?? 0) > 0 && (
                          <Tooltip text={t('traceHound.messages.latencyTooltip', { ttft: (turn.avg_ttft_ms ?? 0).toFixed(0), tpot: (turn.avg_tpot_ms ?? 0).toFixed(1) })}>
                            <div style={{ fontSize: 11, color: C.textFaint, marginTop: 1, cursor: 'help' }}>⏱️ {t('traceHound.messages.latencyAvg', { seconds: ((turn.avg_total_latency_ms ?? 0) / 1000).toFixed(1) })}</div>
                          </Tooltip>
                        )}
                        {(turn.context_usage_percent ?? 0) > 0 && (
                          <Tooltip text={t('traceHound.messages.contextTooltip', { tokens: turn.context_window_tokens?.toLocaleString() ?? '?' })}>
                            <div style={{ fontSize: 11, color: (turn.context_usage_percent ?? 0) > 80 ? C.danger : C.textFaint, marginTop: 1, cursor: 'help' }}>
                              📏 {(turn.context_usage_percent ?? 0).toFixed(1)}%
                            </div>
                          </Tooltip>
                        )}
                        {(turn.total_cost ?? 0) > 0 && (
                          <div style={{ fontSize: 11, color: C.textFaint, marginTop: 1 }}>💰 ${(turn.total_cost ?? 0).toFixed(4)}</div>
                        )}
                        {turn.models_used && turn.models_used.length > 0 && (
                          <div style={{ fontSize: 10, color: C.textFaint, marginTop: 1 }}>{turn.models_used.join(', ')}</div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── View 3: Turn Detail ───────────────────────────────────────────────────────

const EVENT_META: Record<string, { icon: string; labelKey: string; color: string; subtle: string }> = {
  user:                 { icon: '🧑', labelKey: 'user',             color: C.info,    subtle: C.infoSubtle },
  'chat.reasoning':     { icon: '🤔', labelKey: 'reasoning',        color: C.violet,  subtle: C.violetSubtle },
  'chat.tool_call':     { icon: '🔧', labelKey: 'toolCall',         color: C.warn,    subtle: C.warnSubtle },
  'chat.tool_update':   { icon: '⏳', labelKey: 'toolUpdate',       color: C.warn,    subtle: C.warnSubtle },
  'chat.tool_result':   { icon: '',   labelKey: 'toolResult',       color: C.ok,      subtle: C.okSubtle },
  'chat.final':         { icon: '💬', labelKey: 'response',         color: C.violet,  subtle: C.violetSubtle },
  'chat.file':          { icon: '📄', labelKey: 'file',             color: C.teal,    subtle: C.infoSubtle },
  'chat.usage_metadata':{ icon: '⚡', labelKey: 'llmCall',          color: C.violet,  subtle: C.violetSubtle },
  'chat.usage_summary': { icon: '📊', labelKey: 'usageSummary',     color: C.textMuted, subtle: C.surfaceMuted },
  'chat.error':         { icon: '🚨', labelKey: 'error',            color: C.danger,  subtle: C.dangerSubtle },
};

function RecordCard({ rec, displayDelta, endDelta, allRecords, expandAll = false }: { rec: HistoryRecord; displayDelta: number | null; endDelta?: number | null; allRecords?: HistoryRecord[]; expandAll?: boolean }) {
  const { t } = useTranslation();
  const key = rec.role === 'user' ? 'user' : (rec.event_type ?? '');
  const meta = EVENT_META[key];
  const icon  = key === 'chat.tool_result' ? (isFailedToolResult(rec) ? '❌' : '✅') : (meta?.icon ?? '•');
  const color = (key === 'chat.tool_result' && isFailedToolResult(rec)) ? C.danger : (meta?.color ?? C.textMuted);
  const subtle = meta?.subtle ?? C.surfaceMuted;
  const danger = isDangerous(rec);

  const headerLabel = recordHeaderLabel(rec, t);

  // Body text
  const bodyText = key === 'chat.error'
    ? (rec.error ?? rec.error_detail ?? rec.content ?? '')
    : (rec.content ?? '');

  // Pre-format tool call arguments
  const fmtArgs = key === 'chat.tool_call' ? (() => {
    const args = (rec.tool_call as Record<string, unknown>)?.arguments ?? rec.content;
    try { return JSON.stringify(typeof args === 'string' ? JSON.parse(args) : args, null, 2); }
    catch { return String(args ?? ''); }
  })() : '';

  const resultText = key === 'chat.tool_result' ? (rec.result ?? rec.content ?? '') : '';

  // Extract usage_metadata details
  const um = key === 'chat.usage_metadata' ? rec.metadata?.usage_metadata : null;
  const hasUsageError = um && (um.code !== 0 || um.err_msg);

  // Cards collapse to their header by default so a long trajectory fits on one
  // screen. The user message is always visible; every other card (final
  // response, tool calls/results, reasoning, usage) starts collapsed.
  // `expandAll` (turn-level toggle) overrides; a manual header click pins a
  // per-card override until the toggle is flipped (parent remounts via key).
  const isUser = key === 'user';
  const collapsible = !isUser;
  const [local, setLocal] = useState<boolean | null>(null);
  const shown = local ?? (expandAll ? true : false);

  // displayDelta is computed by TurnDetailView and tracks time within the current attempt,
  // resetting to 0 at the start of each attempt (after a gap separator). This avoids showing
  // "+56s" when the actual attempt took ~1s (the 56s was idle time between retries).

  return (
    <div id={`rec-${rec.id}`} data-event-type={rec.event_type} data-tool-call-id={rec.tool_call_id} style={{ border: `1px solid ${subtle}`, borderLeft: `3px solid ${danger ? C.danger : color}`, borderRadius: 6, marginBottom: 8, background: C.surface, overflow: 'hidden' }}>
      {/* Header */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: collapsible ? 'pointer' : 'default', background: danger ? C.dangerSubtle : subtle }}
        onClick={() => collapsible && setLocal(!shown)}
      >
        <span style={{ fontSize: 14 }}>{icon}</span>
        <span style={{ fontWeight: 600, fontSize: 13, color, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{headerLabel}</span>
        {recordAgent(rec) && agentTag(recordAgent(rec), t)}
        {rec.mode && <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: C.surfaceMuted, color: C.textMuted, flexShrink: 0 }}>{rec.mode}</span>}
        {(key === 'chat.tool_call' || key === 'chat.tool_update' || key === 'chat.tool_result') && rec.tool_call_id && (
          <span style={{ fontSize: 10, color: C.textFaint, fontFamily: 'monospace', flexShrink: 0 }}>#{String(rec.tool_call_id).slice(-8)}</span>
        )}
        {danger && <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 3, background: C.dangerSubtle, color: C.danger, border: `1px solid ${C.dangerSubtle}` }}>{t('traceHound.records.dangerous')}</span>}
        {/* Timing: absolute time + elapsed time within this attempt */}
        <span style={{ fontSize: 11, color: C.textFaint, textAlign: 'right', flexShrink: 0 }}>
          <span>{fmtTime(rec.timestamp)}</span>
          {displayDelta != null && displayDelta > 0 && (
            <Tooltip text={
              endDelta != null && endDelta > displayDelta
                ? t('traceHound.records.llmCallToResponse', { start: fmtDelta(displayDelta), end: fmtDelta(endDelta) })
                : t('traceHound.records.deltaSinceStart', { delta: fmtDelta(displayDelta) })
            }>
              <span style={{ marginLeft: 5, color: displayDelta > 10 ? C.warn : C.borderStrong, cursor: 'help' }}>
                {endDelta != null && endDelta > displayDelta
                  ? `${fmtDelta(displayDelta)} → ${fmtDelta(endDelta)}`
                  : fmtDelta(displayDelta)}
              </span>
            </Tooltip>
          )}
        </span>
        {collapsible && <span style={{ fontSize: 12, color: C.textFaint }}>{shown ? '▲' : '▼'}</span>}
        {rec.id && <span style={{ fontSize: 9, color: C.borderStrong, fontFamily: 'monospace', flexShrink: 0 }} title={t('traceHound.records.recordId', { id: rec.id })}>{rec.id.replace(/:(assistant|user)$/, '').slice(-12)}</span>}
      </div>

      {/* User message — always visible */}
      {key === 'user' && bodyText && (
        <div style={{ padding: '8px 12px', fontSize: 13, color: C.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word', borderTop: `1px solid ${subtle}` }}>
          {bodyText}
        </div>
      )}
      {/* Final response — collapsed by default, expand on click */}
      {key === 'chat.final' && shown && bodyText && (
        <div style={{ padding: '8px 12px', fontSize: 13, color: C.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word', borderTop: `1px solid ${subtle}` }}>
          {bodyText}
        </div>
      )}

      {/* Tool call arguments (shown when expanded) */}
      {key === 'chat.tool_call' && shown && fmtArgs && (
        <div style={{ padding: '8px 12px', borderTop: `1px solid ${subtle}` }}>
          <pre style={{ margin: 0, fontSize: 12, background: C.surfaceMuted, borderRadius: 4, padding: '8px', overflowX: 'auto', color: C.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {fmtArgs}
          </pre>
        </div>
      )}

      {/* Tool result (shown when expanded) */}
      {key === 'chat.tool_result' && shown && (resultText || isFailedToolResult(rec)) && (
        <div style={{ padding: '8px 12px', borderTop: `1px solid ${subtle}` }}>
          {isFailedToolResult(rec) && <div style={{ fontSize: 12, color: C.danger, marginBottom: 6 }}><strong>{rec.error_type ? `❌ ${rec.error_type}` : t('traceHound.records.toolCallFailed')}</strong>{rec.error_detail ? `: ${rec.error_detail}` : ''}</div>}
          {resultText && (
            <pre style={{ margin: 0, fontSize: 12, background: C.surfaceMuted, borderRadius: 4, padding: '8px', overflowX: 'auto', color: isFailedToolResult(rec) ? C.danger : C.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 300, overflowY: 'auto' }}>
              {resultText}
            </pre>
          )}
          {rec.raw_output && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, fontWeight: 600 }}>{t('traceHound.records.rawOutput')}</div>
              <pre style={{ margin: 0, fontSize: 11, background: C.surfaceMuted, borderRadius: 4, padding: '8px', overflowX: 'auto', color: C.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 300, overflowY: 'auto' }}>
                {(() => {
                  try { return JSON.stringify(rec.raw_output, null, 2); }
                  catch { return String(rec.raw_output); }
                })()}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Other types (reasoning / file / error) — shown when expanded */}
      {(key === 'chat.reasoning' || key === 'chat.file' || key === 'chat.error') && shown && bodyText && (
        <div style={{ padding: '8px 12px', borderTop: `1px solid ${subtle}` }}>
          <div style={{ fontSize: 13, color: key === 'chat.error' ? C.danger : C.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontStyle: key === 'chat.reasoning' ? 'italic' : 'normal' }}>
            {bodyText}
          </div>
        </div>
      )}

      {/* Usage metadata: LLM call details (collapsed with the card; hidden via
          display so the prompt/response sub-components keep stable hooks) */}
      {key === 'chat.usage_metadata' && um && (
        <div style={{ padding: '8px 12px', borderTop: `1px solid ${subtle}`, display: shown ? 'block' : 'none' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
            {um.model_name && <span style={chipStyle}>{um.model_name}</span>}
            {um.input_tokens != null && um.output_tokens != null && (
              <span style={chipStyle}>{t('traceHound.records.inputOutputTotal', { input: um.input_tokens.toLocaleString(), output: um.output_tokens.toLocaleString(), total: um.total_tokens?.toLocaleString() ?? '?' })}</span>
            )}
            {um.cache_tokens != null && um.cache_tokens > 0 && <span style={chipStyle}>{t('traceHound.records.cache', { count: um.cache_tokens.toLocaleString() })}</span>}
          </div>
          {shown && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
              {rec.metadata?.total_latency_ms != null && (
                <Tooltip text={t('traceHound.records.latencyTooltip')}><span style={{ ...chipStyle, cursor: 'help' }}>{t('traceHound.records.latencyTotal', { seconds: (rec.metadata.total_latency_ms / 1000).toFixed(2) })}</span></Tooltip>
              )}
              {rec.metadata?.ttft_ms != null && (
                <Tooltip text={t('traceHound.records.ttftTooltip')}><span style={{ ...chipStyle, cursor: 'help' }}>{t('traceHound.records.ttft', { ms: rec.metadata.ttft_ms.toFixed(0) })}</span></Tooltip>
              )}
              {rec.metadata?.tpot_ms != null && (
                <Tooltip text={t('traceHound.records.tpotTooltip')}><span style={{ ...chipStyle, cursor: 'help' }}>{t('traceHound.records.tpot', { ms: rec.metadata.tpot_ms.toFixed(1) })}</span></Tooltip>
              )}
              {um.total_latency != null && um.total_latency > 0 && (
                <Tooltip text={t('traceHound.records.rawLatencyTooltip')}><span style={{ ...chipStyle, cursor: 'help' }}>{t('traceHound.records.rawLatency', { seconds: um.total_latency.toFixed(2) })}</span></Tooltip>
              )}
              {um.input_cost != null && um.input_cost > 0 && um.output_cost != null && um.output_cost > 0 && (
                <span style={chipStyle}>{t('traceHound.records.costInOut', { input: um.input_cost.toFixed(4), output: um.output_cost.toFixed(4) })}</span>
              )}
              {um.total_cost != null && um.total_cost > 0 && (
                <span style={chipStyle}>{t('traceHound.records.costTotal', { count: um.total_cost.toFixed(4) })}</span>
              )}
              {rec.metadata?.result_type && <span style={chipStyle}>📋 {rec.metadata.result_type}</span>}
              {um.task_id && <span style={chipStyle}>🎯 {um.task_id}</span>}
              {um.first_token_time && <span style={chipStyle}>🕐 FT {um.first_token_time}</span>}
              {um.request_start_time && <span style={chipStyle}>🕐 RS {um.request_start_time}</span>}
            </div>
          )}
          {/* LLM Prompt — always shown so user knows if it's missing */}
          {key === 'chat.usage_metadata' && um && (() => {
            const [showFullPrompt, setShowFullPrompt] = useState(false);
            return (
              <div style={{ marginTop: 8, padding: '8px 10px', background: C.surfaceMuted, borderRadius: 4, border: `1px solid ${C.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <strong style={{ color: C.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>{t('traceHound.records.llmPrompt')}</strong>
                  {um.prompt ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <button
                        style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, border: `1px solid ${C.borderStrong}`, background: C.surface, color: C.textMuted, cursor: 'pointer' }}
                        onClick={() => setShowFullPrompt(x => !x)}
                      >
                        {showFullPrompt ? t('traceHound.records.collapse') : t('traceHound.records.showFull')}
                      </button>
                      <CopyButton text={um.prompt} />
                    </div>
                  ) : null}
                </div>
                {um.prompt ? (
                  <pre style={{ margin: '6px 0 0', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: C.text, maxHeight: showFullPrompt ? undefined : 240, overflowY: 'auto' }}>{um.prompt}</pre>
                ) : (
                  <div style={{ marginTop: 6, fontSize: 11, color: C.textFaint, fontStyle: 'italic' }}>
                    {t('traceHound.records.promptNotRecorded')}
                  </div>
                )}
              </div>
            );
          })()}

          {/* LLM Response — shows the raw LLM output (final text, tool calls, reasoning, errors) that correspond to this usage_metadata record */}
          {key === 'chat.usage_metadata' && um && (() => {
            const responseRecs = findLLMResponseForUsage(rec, allRecords ?? []);
            const [showFullResponse, setShowFullResponse] = useState(false);

            // Build a combined text representation of the response
            const responseParts = responseRecs.map(r => {
              const et = r.event_type ?? '';
              if (et === 'chat.final') {
                return { type: 'text' as const, label: t('traceHound.records.partText'), content: r.content ?? '' };
              }
              if (et === 'chat.llm_call_end') {
                return { type: 'text' as const, label: t('traceHound.records.partText'), content: r.content ?? '' };
              }
              if (et === 'chat.tool_call') {
                const tc = r.tool_call as Record<string, unknown> | undefined;
                const name = tc?.name ?? r.tool_name ?? 'unknown';
                const args = tc?.arguments ?? r.content ?? '';
                let fmtArgs = '';
                try { fmtArgs = JSON.stringify(typeof args === 'string' ? JSON.parse(args) : args, null, 2); }
                catch { fmtArgs = String(args ?? ''); }
                return { type: 'tool_call' as const, label: t('traceHound.records.partTool', { name }), content: fmtArgs };
              }
              if (et === 'chat.reasoning') {
                return { type: 'reasoning' as const, label: t('traceHound.records.partReasoning'), content: r.content ?? '' };
              }
              if (et === 'chat.delta') {
                return { type: 'delta' as const, label: t('traceHound.records.partDelta'), content: r.content ?? '' };
              }
              if (et === 'chat.error') {
                return { type: 'error' as const, label: t('traceHound.records.partError'), content: r.error ?? r.error_detail ?? r.content ?? '' };
              }
              return null;
            }).filter(Boolean) as { type: string; label: string; content: string }[];

            const hasResponse = responseParts.length > 0;
            const combinedText = responseParts.map(p => `[${p.label}]\n${p.content}`).join('\n\n---\n\n');

            return (
              <div style={{ marginTop: 8, padding: '8px 10px', background: C.okSubtle, borderRadius: 4, border: `1px solid ${C.okSubtle}` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <strong style={{ color: C.ok, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>{t('traceHound.records.llmResponse')}</strong>
                  {hasResponse ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <button
                        style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, border: `1px solid ${C.okSubtle}`, background: C.surface, color: C.ok, cursor: 'pointer' }}
                        onClick={() => setShowFullResponse(x => !x)}
                      >
                        {showFullResponse ? t('traceHound.records.collapse') : t('traceHound.records.showFull')}
                      </button>
                      <CopyButton text={combinedText} />
                    </div>
                  ) : null}
                </div>
                {hasResponse ? (
                  <div style={{ marginTop: 6, maxHeight: showFullResponse ? undefined : 240, overflowY: 'auto' }}>
                    {responseParts.map((part, i) => (
                      <div key={i} style={{ marginBottom: i < responseParts.length - 1 ? 8 : 0 }}>
                        <div style={{ fontSize: 10, fontWeight: 600, color: C.ok, marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.5 }}>{part.label}</div>
                        <pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: C.ok, background: C.okSubtle, borderRadius: 3, padding: '6px 8px' }}>{part.content}</pre>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ marginTop: 6, fontSize: 11, color: C.textFaint, fontStyle: 'italic' }}>
                    {t('traceHound.records.noResponseEvents')}
                  </div>
                )}
              </div>
            );
          })()}
          {rec.session_id && (
            <div style={{ fontSize: 10, color: C.borderStrong, marginTop: 4, fontFamily: 'monospace' }}>{t('traceHound.records.sessionId', { id: rec.session_id })}</div>
          )}
          {hasUsageError && (
            <div style={{ fontSize: 12, color: C.danger, marginTop: 4 }}>
              {t('traceHound.records.usageError', { code: um.code, message: um.err_msg })}
            </div>
          )}
        </div>
      )}

      {/* Tool update: status + arguments */}
      {key === 'chat.tool_update' && (
        <div style={{ padding: '8px 12px', borderTop: `1px solid ${subtle}` }}>
          {rec.status && (
            <div style={{ marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4, background: rec.status === 'in_progress' ? C.infoSubtle : C.okSubtle, color: rec.status === 'in_progress' ? C.info : C.ok }}>
                {rec.status}
              </span>
            </div>
          )}
          {rec.arguments && (
            <pre style={{ margin: 0, fontSize: 12, background: C.surfaceMuted, borderRadius: 4, padding: '8px', overflowX: 'auto', color: C.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {(() => { try { return JSON.stringify(JSON.parse(rec.arguments), null, 2); } catch { return rec.arguments; } })()}
            </pre>
          )}
        </div>
      )}

      {/* Usage summary chips */}
      {key === 'chat.usage_summary' && (
        <div style={{ padding: '6px 12px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {rec.model && <span style={chipStyle}>{rec.model}</span>}
          {rec.total_tokens != null && <span style={chipStyle}>{t('traceHound.records.tokens', { count: rec.total_tokens.toLocaleString() })}</span>}
          {rec.usage?.input_tokens != null && rec.usage?.output_tokens != null && (
            <span style={chipStyle}>{t('traceHound.records.inputOutput', { input: rec.usage.input_tokens.toLocaleString(), output: rec.usage.output_tokens.toLocaleString() })}</span>
          )}
          {(rec.usage_percent ?? 0) > 0 && (
            <Tooltip text={t('traceHound.messages.contextTooltip', { tokens: rec.context_window_tokens?.toLocaleString() ?? '?' })}>
              <span style={{ ...chipStyle, cursor: 'help' }}>{t('traceHound.records.contextPercent', { percent: rec.usage_percent?.toFixed(1) ?? '?' })}</span>
            </Tooltip>
          )}
          {rec.ttft_ms != null && <Tooltip text={t('traceHound.records.ttftTooltip')}><span style={{ ...chipStyle, cursor: 'help' }}>{t('traceHound.records.ttft', { ms: rec.ttft_ms.toFixed(0) })}</span></Tooltip>}
          {rec.tpot_ms != null && <Tooltip text={t('traceHound.records.tpotTooltip')}><span style={{ ...chipStyle, cursor: 'help' }}>{t('traceHound.records.tpot', { ms: rec.tpot_ms.toFixed(1) })}</span></Tooltip>}
          {rec.total_latency_ms != null && <Tooltip text={t('traceHound.records.latencyTooltip')}><span style={{ ...chipStyle, cursor: 'help' }}>{t('traceHound.records.latencyChip', { seconds: (rec.total_latency_ms / 1000).toFixed(1) })}</span></Tooltip>}
          {rec.session_id && <span style={{ fontSize: 9, color: C.borderStrong, fontFamily: 'monospace', alignSelf: 'center' }}>{rec.session_id.slice(-12)}</span>}
        </div>
      )}
    </div>
  );
}

/// Gap threshold: if two consecutive records are more than this apart, show an idle separator
const IDLE_GAP_THRESHOLD_S = 30;

export function TurnDetailView() {
  const { t } = useTranslation();
  const { selectedSession, selectedTurnId, turns, turnRecords, loading, error, back, clearError } = useTraceHoundStore();
  const turn = turns.find(t => t.turn_id === selectedTurnId);

  // When a cross-link (e.g. a failing tool row in the Stats panel) requested a
  // specific record, scroll its card into view once the records have loaded.
  const focusRecordId = useTraceHoundStore(s => s.focusRecordId);
  useEffect(() => {
    if (!focusRecordId || turnRecords.length === 0) return;
    // tool_call and tool_result cards share the same tool_call_id; prefer the
    // tool_result card (the failing record) when present.
    const el =
      Array.from(document.querySelectorAll(`[data-tool-call-id="${focusRecordId}"]`))
        .find(n => n.getAttribute('data-event-type') === 'chat.tool_result') ??
      document.querySelector(`[data-tool-call-id="${focusRecordId}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusRecordId, turnRecords]);

  // Collapse-by-default: every card shows only its header until expanded.
  // "Expand all" overrides; toggling it remounts the cards (key) to reset
  // any per-card manual overrides.
  const [expandAll, setExpandAll] = useState(false);

  // Records | Graph switch (Langfuse-style per-turn graph view).
  const [tab, setTab] = useState<'records' | 'graph'>('records');
  const scrollToRecord = (recordId: string) =>
    document.getElementById(`rec-${recordId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // A graph node click switches to the Records tab, but the records list only
  // mounts once that tab renders. Stash the target and scroll from an effect
  // keyed on the tab so the record is revealed after mount.
  const [pendingRecordId, setPendingRecordId] = useState<string | null>(null);
  useEffect(() => {
    if (tab === 'records' && pendingRecordId) {
      scrollToRecord(pendingRecordId);
      setPendingRecordId(null);
    }
  }, [tab, pendingRecordId]);

  // Floating "back to top" button — the panel div is the scroll container.
  const panelRef = useRef<HTMLDivElement>(null);
  const [showTop, setShowTop] = useState(false);

  // Build display list: inject idle gap separators between records that are far apart.
  // Also compute displayDelta per record = elapsed time within the current attempt,
  // resetting to 0 whenever a new attempt starts (right after a separator).
  // This means the first record of each attempt shows no "+Xs", and subsequent records
  // show time elapsed within that attempt — never the misleading idle gap duration.
  const displayItems = useMemo(() => {
    type Item =
      | { type: 'record'; rec: HistoryRecord; displayDelta: number | null; endDelta?: number | null }
      | { type: 'gap'; seconds: number };
    const items: Item[] = [];
    let attemptStartTs = 0;
    let prevTs = 0;

    const pushRecord = (rec: HistoryRecord, i: number, displayDelta: number | null) => {
      let endDelta: number | null = null;
      if (rec.event_type === 'chat.usage_metadata') {
        // LLM Call card: show when the call actually ended — the first
        // chat.llm_call_end after this usage record (the response/answer of that
        // call), not later tool execution or the next call.
        let endTs = 0;
        for (let j = i + 1; j < turnRecords.length; j++) {
          const rj = turnRecords[j];
          const et = rj.event_type ?? '';
          if (et === 'chat.usage_metadata' || rj.role === 'user') break;
          if (et === 'chat.llm_call_end') {
            endTs = rj.timestamp ?? 0;
            break;
          }
          if (!endTs && (et === 'chat.final' || et === 'chat.tool_call' || et === 'chat.delta')) {
            endTs = rj.timestamp ?? 0;
          }
        }
        if (endTs > 0) {
          const d = endTs - attemptStartTs;
          endDelta = d > 0 ? d : null;
        }
      }
      items.push({ type: 'record', rec, displayDelta, endDelta });
    };

    turnRecords.forEach((rec, i) => {
      const ts = rec.timestamp ?? 0;

      if (i === 0) {
        attemptStartTs = ts;
        prevTs = ts;
        pushRecord(rec, i, null);
        return;
      }

      const deltaFromPrev = ts - prevTs;
      const prevEt = turnRecords[i - 1]?.event_type ?? '';

      // A tool_result after a tool_call is the same tool execution — the gap is
      // the tool's runtime, not idle time and not a retry. Keep the attempt
      // clock running so the result shows its real elapsed time.
      const isToolResultGap = rec.event_type === 'chat.tool_result' && prevEt === 'chat.tool_call';

      if (deltaFromPrev > IDLE_GAP_THRESHOLD_S && !isToolResultGap) {
        // Large idle gap: separator + reset attempt clock
        items.push({ type: 'gap', seconds: deltaFromPrev });
        attemptStartTs = ts;
        // First record of the new attempt — no delta to show
        pushRecord(rec, i, null);
      } else {
        const attemptDelta = ts - attemptStartTs;
        pushRecord(rec, i, attemptDelta > 0 ? attemptDelta : null);
      }

      prevTs = ts;
    });

    return items;
  }, [turnRecords]);

  const downloadPage = () => {
    const chunks: string[] = [];
    chunks.push(`USER MESSAGE #${(turn?.turn_index ?? 0) + 1}${selectedSession?.title ? ` — ${selectedSession.title}` : ''}`);
    if (turn?.timestamp) {
      let meta = fmtDateTime(turn.timestamp);
      if (turn.duration_seconds > 0 && turn.retry_count <= 1) meta += ` · ${fmtDuration(turn.duration_seconds)}`;
      chunks.push(meta);
    }
    const chips: string[] = [];
    if (turn) {
      if (turn.outcome) chips.push(`outcome: ${turn.outcome}${turn.issues && turn.issues.length > 0 ? ` (${turn.issues.join(', ')})` : ''}`);
      if (turn.total_tokens > 0) chips.push(`${turn.total_tokens.toLocaleString()} tok`);
      if (turn.llm_call_count > 0) chips.push(`${turn.llm_call_count} LLM call${turn.llm_call_count !== 1 ? 's' : ''}`);
      if (turn.tool_names.length > 0) chips.push(`${turn.tool_names.length} tool${turn.tool_names.length !== 1 ? 's' : ''}`);
      if (turn.skill_names.length > 0) chips.push(`${turn.skill_names.length} skill${turn.skill_names.length !== 1 ? 's' : ''}`);
      if (turn.tool_failures > 0) chips.push(`${turn.tool_failures} failed`);
      if (turn.file_count > 0) chips.push(`${turn.file_count} file${turn.file_count !== 1 ? 's' : ''}`);
      if ((turn.avg_total_latency_ms ?? 0) > 0) chips.push(`${((turn.avg_total_latency_ms ?? 0) / 1000).toFixed(1)}s avg`);
      const ctxPct = turn.context_usage_percent ?? 0;
      if (ctxPct > 0) chips.push(`${ctxPct.toFixed(1)}% ctx`);
      if ((turn.total_cost ?? 0) > 0) chips.push(`$${(turn.total_cost ?? 0).toFixed(4)}`);
      if (turn.models_used && turn.models_used.length > 0) chips.push(`models: ${turn.models_used.join(', ')}`);
      if (turn.retry_count > 1) chips.push(`${turn.retry_count} attempts`);
    }
    if (chips.length) chunks.push(chips.join(' · '));

    chunks.push('');
    for (const item of displayItems) {
      if (item.type === 'gap') {
        chunks.push('', t('traceHound.turnDetail.gapIdle', { duration: fmtDuration(item.seconds) }), '');
      } else {
        chunks.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        chunks.push(recordToText(item.rec, turnRecords, t));
      }
    }
    downloadText(chunks.join('\n'), `turn-${selectedTurnId?.slice(0, 8) ?? 'export'}-page.txt`);
  };

  const downloadMd = () => {
    downloadText(turnToStepByStepMarkdown(turnRecords), `turn-${selectedTurnId?.slice(0, 8) ?? 'export'}-step-by-step.md`);
  };

  return (
    <div style={panelStyle} ref={panelRef} onScroll={e => setShowTop((e.target as HTMLDivElement).scrollTop > 400)}>
      <div style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <button style={btnStyle} onClick={back}>{t('traceHound.back')}</button>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ ...titleStyle, marginBottom: 0, fontSize: 15 }}>
              {t('traceHound.turnDetail.title', { index: (turn?.turn_index ?? 0) + 1 })}
              {selectedSession?.title && <span style={{ fontWeight: 400, color: C.textMuted, fontSize: 13, marginLeft: 8 }}>— {selectedSession.title}</span>}
            </h2>
            {turn?.timestamp && (
              <div style={{ fontSize: 11, color: C.textFaint, marginTop: 2 }}>
                {fmtDateTime(turn.timestamp)}
                {/* Don't show total wall-time duration for retried turns — it includes idle gaps between retries */}
                {turn.duration_seconds > 0 && turn.retry_count <= 1 && (
                  <span style={{ marginLeft: 8 }}>· {fmtDuration(turn.duration_seconds)}</span>
                )}
              </div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0 }}>
          {turn && <OutcomeBadge outcome={turn.outcome} issues={turn.issues} t={t} />}
          {turn && turn.total_tokens > 0 && <span style={chipStyle}>{t('traceHound.messages.tokens', { count: turn.total_tokens.toLocaleString() })}</span>}
          {turn && turn.llm_call_count > 0 && <span style={chipStyle}>{t('traceHound.messages.llmCalls', { count: turn.llm_call_count })}</span>}
          {turn && turn.tool_names.length > 0 && <span style={{ ...chipStyle, color: C.warn, background: C.warnSubtle, border: `1px solid ${C.warnSubtle}` }}>{t('traceHound.turnDetail.tools', { count: turn.tool_names.length })}</span>}
          {turn && turn.skill_names.length > 0 && <span style={{ ...chipStyle, color: C.violet, background: C.violetSubtle, border: `1px solid ${C.violetSubtle}` }}>{t('traceHound.turnDetail.skills', { count: turn.skill_names.length })}</span>}
          {turn && turn.tool_failures > 0 && <span style={{ ...chipStyle, color: C.danger, background: C.dangerSubtle, border: `1px solid ${C.dangerSubtle}` }}>{turn.tool_failures} {t('traceHound.messages.failed')}</span>}
          {turn && turn.file_count > 0 && <span style={{ ...chipStyle, color: C.ok, background: C.okSubtle, border: `1px solid ${C.okSubtle}` }}>{t('traceHound.messages.fileCount', { count: turn.file_count })}</span>}
          {turn && (turn.avg_total_latency_ms ?? 0) > 0 && (
            <Tooltip text={t('traceHound.messages.latencyTooltip', { ttft: (turn.avg_ttft_ms ?? 0).toFixed(0), tpot: (turn.avg_tpot_ms ?? 0).toFixed(1) })}>
              <span style={{ ...chipStyle, cursor: 'help' }}>⏱️ {t('traceHound.messages.latencyAvg', { seconds: ((turn.avg_total_latency_ms ?? 0) / 1000).toFixed(1) })}</span>
            </Tooltip>
          )}
          {turn && (turn.context_usage_percent ?? 0) > 0 && (
            <Tooltip text={t('traceHound.messages.contextTooltip', { tokens: turn.context_window_tokens?.toLocaleString() ?? '?' })}>
              <span style={{ ...chipStyle, cursor: 'help', color: (turn.context_usage_percent ?? 0) > 80 ? C.danger : C.text }}>📏 {(turn.context_usage_percent ?? 0).toFixed(1)}%</span>
            </Tooltip>
          )}
          {turn && (turn.total_cost ?? 0) > 0 && <span style={chipStyle}>💰 ${(turn.total_cost ?? 0).toFixed(4)}</span>}
          {turn && turn.models_used && turn.models_used.length > 0 && (
            <span style={{ ...chipStyle }}>🧠 {turn.models_used.join(', ')}</span>
          )}
          {turn && turn.retry_count > 1 && (
            <Tooltip text={t('traceHound.turnDetail.retriesTooltip', { count: turn.retry_count })}>
              <span style={{ ...chipStyle, color: C.warn, background: C.warnSubtle, border: `1px solid ${C.warnSubtle}`, cursor: 'help' }}>
                {turn.retry_count} {t('traceHound.messages.attempts')}
              </span>
            </Tooltip>
          )}
          <button style={{ ...btnStyle, fontSize: 12 }} title={expandAll ? t('traceHound.turnDetail.collapseAllTooltip') : t('traceHound.turnDetail.expandAllTooltip')}
            onClick={() => setExpandAll(x => !x)}
            disabled={turnRecords.length === 0}>
            {expandAll ? t('traceHound.turnDetail.collapseAll') : t('traceHound.turnDetail.expandAll')}
          </button>
          <button style={{ ...btnStyle, fontSize: 12 }} title={t('traceHound.turnDetail.downloadJsonTooltip')}
            onClick={() => downloadJson(turnRecords, `turn-${selectedTurnId?.slice(0, 8) ?? 'export'}.json`)}
            disabled={turnRecords.length === 0}>
            {t('traceHound.turnDetail.downloadJson')}
          </button>
          <button style={{ ...btnStyle, fontSize: 12 }} title={t('traceHound.turnDetail.downloadPageTooltip')}
            onClick={downloadPage}
            disabled={turnRecords.length === 0}>
            {t('traceHound.turnDetail.downloadPage')}
          </button>
          <button style={{ ...btnStyle, fontSize: 12 }} title={t('traceHound.turnDetail.downloadMdTooltip')}
            onClick={downloadMd}
            disabled={turnRecords.length === 0}>
            {t('traceHound.turnDetail.downloadMd')}
          </button>
        </div>
      </div>

      {/* Wall-clock strip of this turn's records — click a dot to jump to its card */}
      <TimelineBand
        records={turnRecords}
        onClickRecord={r => document.getElementById(`rec-${r.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
      />

      {error && <ErrorBanner message={error} onClose={clearError} />}
      {loading && <div style={emptyStyle}>{t('traceHound.turnDetail.loading')}</div>}
      {!loading && turnRecords.length === 0 && <div style={emptyStyle}>{t('traceHound.turnDetail.noRecords')}</div>}

      {!loading && turnRecords.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            {(['records', 'graph'] as const).map(k => (
              <button key={k} onClick={() => setTab(k)} style={{
                fontSize: 12, padding: '4px 12px', borderRadius: 8, cursor: 'pointer',
                border: `1px solid ${tab === k ? C.info : C.border}`,
                background: tab === k ? C.infoSubtle : C.surface,
                color: tab === k ? C.info : C.textMuted, fontWeight: tab === k ? 600 : 400,
              }}>{t(`traceHound.graph.${k}`)}</button>
            ))}
          </div>
          {tab === 'records' ? (
            displayItems.map((item, i) => {
              if (item.type === 'gap') {
                return (
                  <div key={`gap-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 8px', color: C.textFaint, fontSize: 11 }}>
                    <div style={{ flex: 1, height: 1, background: C.border }} />
                    <span style={{ flexShrink: 0, background: C.surfaceMuted, border: `1px solid ${C.border}`, padding: '2px 10px', borderRadius: 10, color: C.textFaint, fontSize: 11 }}>
                      {t('traceHound.turnDetail.gapIdle', { duration: fmtDuration(item.seconds) })}
                    </span>
                    <div style={{ flex: 1, height: 1, background: C.border }} />
                  </div>
                );
              }
              const rec = item.rec;
              return <RecordCard key={`${expandAll}:${rec.id ?? `${rec.event_type}-${i}`}`} rec={rec} displayDelta={item.displayDelta} endDelta={item.endDelta} allRecords={turnRecords} expandAll={expandAll} />;
            })
          ) : (
            <TraceGraph
              records={turnRecords}
              onSelectRecord={id => {
                setPendingRecordId(id);
                setTab('records');
              }}
            />
          )}
        </>
      )}

      {/* Floating scroll-to-top button (appears once scrolled down) */}
      {showTop && (
        <button
          onClick={() => panelRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
          style={{ position: 'fixed', bottom: 28, right: 28, width: 40, height: 40, borderRadius: '50%', border: `1px solid ${C.borderStrong}`, background: C.surface, color: C.text, fontSize: 18, cursor: 'pointer', boxShadow: '0 4px 12px rgba(0,0,0,0.18)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          title={t('traceHound.scrollToTop')}
        >
          ↑
        </button>
      )}
    </div>
  );
}

// ── Session-scoped Trajectory Panel (chat integration) ───────────────────────

interface TrajectoryPanelProps {
  sessionId: string;
  sessionTitle: string;
  sessionMode?: string | null;
  isConnected: boolean;
  /** When enabled (tracehound.live_updates_enabled), live-poll the session's
   *  history file mtime and refresh the trajectory only when it changes. */
  liveUpdatesEnabled?: boolean;
  onClose: () => void;
}

/**
 * The Trajectory panel shown in the chat workspace's right slot. Opens the
 * currently active session's turn list directly (skipping the global session
 * browser), scoped via openCurrentSession. Default view is the turn list; the
 * user drills into a turn's detail from there.
 */
export function TrajectoryPanel({ sessionId, sessionTitle, sessionMode, isConnected, liveUpdatesEnabled = false, onClose }: TrajectoryPanelProps) {
  const { t } = useTranslation();
  const selectedTurnId = useTraceHoundStore((s) => s.selectedTurnId);
  const openCurrentSession = useTraceHoundStore((s) => s.openCurrentSession);
  const refreshTurns = useTraceHoundStore((s) => s.refreshTurns);
  const analyzing = useTraceHoundStore((s) => s.analyzing);
  const loading = useTraceHoundStore((s) => s.loading);

  useEffect(() => {
    void openCurrentSession(sessionId, sessionTitle, sessionMode ?? undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const [live, setLive] = useState(false);
  const mtimeRef = useRef<number | null>(null);

  useEffect(() => {
    if (!liveUpdatesEnabled || !isConnected || analyzing || loading) return;
    let stopped = false;
    const tick = async () => {
      try {
        const r = await webRequest<{ mtime: number | null }>(
          'tracehound.session.mtime',
          { session_id: sessionId }
        );
        if (stopped) return;
        const next = r?.mtime ?? null;
        if (shouldRefetch(mtimeRef.current, next)) {
          await refreshTurns(sessionId);
        }
        if (stopped) return;
        mtimeRef.current = next;
        setLive(true);
      } catch {
        if (!stopped) setLive(false);
      }
    };
    mtimeRef.current = null;
    void tick();
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => { stopped = true; window.clearInterval(id); setLive(false); };
  }, [sessionId, liveUpdatesEnabled, isConnected, analyzing, loading, refreshTurns]);

  return (
    <div
      className="bg-panel"
      style={{ flex: '1 1 0', minWidth: 300, maxWidth: 720, height: '100%', display: 'flex', flexDirection: 'column' }}
      data-testid="tracehound-trajectory-panel"
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '10px 16px', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{t('traceHound.trajectoryPanel')}</span>
        {live && <span style={{ fontSize: 10, color: C.ok }}>● {t('traceHound.live')}</span>}
        <button style={btnStyle} onClick={onClose} title={t('traceHound.trajectoryClose')}>
          ✕ {t('traceHound.close')}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {selectedTurnId ? (
          <TurnDetailView />
        ) : (
          <TurnListView isConnected={isConnected} embedded />
        )}
      </div>
    </div>
  );
}
