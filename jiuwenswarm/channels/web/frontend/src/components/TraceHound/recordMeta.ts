import type { TFunction } from 'i18next';
import type { HistoryRecord } from '../../stores/traceHoundStore';
import { C } from './traceTokens';

// ── Team agent attribution ───────────────────────────────────────────────────

const AGENT_PALETTE = [C.info, C.warn, C.violet, C.danger, C.teal, C.ok];

export function agentColor(name: string): string {
  if (name === 'leader') return C.textMuted;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AGENT_PALETTE[h % AGENT_PALETTE.length];
}

/** Resolve the acting agent (member_name, else 'leader') for a team record. */
export function recordAgent(rec: HistoryRecord): string {
  if (rec.member_name) return rec.member_name;
  if (rec.role === 'leader') return 'leader';
  return '';
}

/** Whether a tool_result record represents a failed tool call. */
export function isFailedToolResult(rec: HistoryRecord): boolean {
  if (rec.error_type) return true;
  // Team-mode tool errors serialize into the result string with no structured
  // error fields (e.g. `success=False data=None error='...'`).
  return typeof rec.result === 'string' && rec.result.includes('success=False');
}

// ── Event metadata / labels ──────────────────────────────────────────────────

export const EVENT_META: Record<string, { icon: string; labelKey: string; color: string; subtle: string }> = {
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

/** Full header text for a record (matches what its card shows). */
export function recordHeaderLabel(rec: HistoryRecord, t: TFunction): string {
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
