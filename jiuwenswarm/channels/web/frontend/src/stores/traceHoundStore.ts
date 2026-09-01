/**
 * TraceHound Store — Session Trajectory Viewer
 *
 * Manages state for browsing past sessions turn-by-turn and viewing
 * each turn's full ReAct trajectory (reasoning → tool calls → final response).
 */

import { create } from 'zustand';
import { webRequest } from '../services/webClient';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TraceHoundSessionItem {
  session_id: string;
  title?: string;
  channel_id?: string;
  last_message_at?: number;
  created_at?: number;
  message_count?: number;
  round_id?: number;                      // how many user message turns occurred
  total_tokens?: number;                  // cumulative tokens consumed
  llm_calls?: number;                     // total LLM API calls across all turns
  total_events?: number;                  // total non-noise events across all turns
  error_count?: number;                   // turns with errors
  total_cache_tokens?: number;            // total cache tokens
  total_input_cost?: number;              // total input cost
  total_output_cost?: number;             // total output cost
  total_cost?: number;                    // total cost
  models_used?: string[];                 // unique models used
  avg_total_latency_ms?: number;          // avg total latency per turn
  avg_ttft_ms?: number;                   // avg TTFT
  avg_tpot_ms?: number;                   // avg TPOT
  max_context_usage_percent?: number;     // max context window usage %
  mode?: string;
}

export interface AgentActivity {
  name: string;
  role: 'leader' | 'member';
  tool_calls: number;
  tool_results: number;
  tool_failures: number;
  responses: number;
  llm_calls: number;
  tokens: number;
  cost: number;
}

export interface TurnSummary {
  turn_id: string;
  turn_index: number;
  /** First 120 chars of the user message for this turn */
  user_content: string;
  /** Full user message text */
  user_message_full?: string;
  timestamp: number;
  tool_names: string[];
  skill_names: string[];
  has_final: boolean;
  has_error: boolean;
  error_category: string | null;
  total_tokens: number;
  tool_failures: number;
  file_count: number;
  final_length: number;
  duration_seconds: number;
  retry_count: number;
  was_deferred: boolean;
  query_type: string;
  outcome: 'completed' | 'completed_with_issues' | 'no_response' | 'error' | 'deferred';
  issues: string[];
  mode: string | null;
  llm_call_count: number;
  event_count: number;
  // Team attribution: which agents acted in this turn (leader first)
  agents?: string[];
  agent_activity?: AgentActivity[];
  // Detailed per-turn data
  assistant_responses?: string[];
  models_used?: string[];
  cache_tokens?: number;
  input_cost?: number;
  output_cost?: number;
  total_cost?: number;
  avg_total_latency_ms?: number;
  avg_ttft_ms?: number;
  avg_tpot_ms?: number;
  context_usage_percent?: number;
  context_window_tokens?: number;
  llm_calls_detail?: LLMCallDetail[];
  tool_calls_detail?: ToolCallDetail[];
  tool_updates_detail?: ToolUpdateDetail[];
  tool_results_detail?: ToolResultDetail[];
}

export interface LLMCallDetail {
  model_name: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_tokens: number;
  input_cost: number;
  output_cost: number;
  total_cost: number;
  total_latency_ms: number;
  ttft_ms: number;
  tpot_ms: number;
  result_type: string;
  code: number;
  err_msg: string;
}

export interface ToolCallDetail {
  name: string;
  arguments: string;
  tool_call_id: string;
  agent?: string | null;
}

export interface ToolUpdateDetail {
  tool_name: string;
  tool_call_id: string;
  arguments: string;
  status: string;
  agent?: string | null;
}

export interface ToolResultDetail {
  tool_name: string;
  tool_call_id: string;
  result: string;
  failed?: boolean;
  error_type?: string | null;
  error_detail?: string | null;
  error?: string | null;
  agent?: string | null;
}

export interface SessionStats {
  total_turns: number;
  error_count: number;
  total_tokens: number;
  total_llm_calls: number;
  total_events: number;
  date_range: string;
  history_file_path: string;
  session_fingerprint?: string;
  // New aggregate stats
  total_cache_tokens?: number;
  total_input_cost?: number;
  total_output_cost?: number;
  total_cost?: number;
  models_used?: string[];
  avg_total_latency_ms?: number;
  avg_ttft_ms?: number;
  avg_tpot_ms?: number;
  max_context_usage_percent?: number;
  channel_id?: string;
}

export interface AnalysisIssue {
  priority: number;          // 1 (highest) – 5 (lowest)
  title: string;
  description: string;
  evidence: string;
  impact: string;
  root_cause: string;
  recommendation: string;
}

export interface SessionAnalysis {
  session_id: string;
  fingerprint: string;       // matches SessionStats.session_fingerprint when fresh
  analyzed_at: number;       // unix timestamp
  issues: AnalysisIssue[];
}

export interface HistoryRecord {
  id: string;
  role: 'user' | 'assistant' | 'leader' | 'teammate';
  request_id: string;
  event_type: string | null;
  content: string;
  timestamp: number;
  mode: string | null;
  /** Team-mode: which member produced this event (leader events carry none) */
  member_name?: string;
  subagent_type?: string;
  sub_session_id?: string;
  tool_name?: string;
  tool_call?: { id: string; name: string; arguments: unknown };
  result?: string;
  raw_output?: {
    message?: string;
    tasks?: unknown[];
    [key: string]: unknown;
  };
  error_type?: string | null;
  error_detail?: string | null;
  error?: string | null;
  total_tokens?: number;
  // LLM timing (populated from raw_output when present)
  ttft_ms?: number | null;
  tpot_ms?: number | null;
  total_latency_ms?: number | null;
  // Per-event timing computed by backend
  delta_from_prev_s?: number;
  elapsed_from_start_s?: number;
  // chat.usage_metadata fields
  metadata?: {
    usage_metadata?: {
      model_name?: string;
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      cache_tokens?: number;
      input_cost?: number;
      output_cost?: number;
      total_cost?: number;
      code?: number;
      err_msg?: string;
      prompt?: string;
      task_id?: string;
      total_latency?: number;
      first_token_time?: string;
      request_start_time?: string;
    };
    result_type?: string;
    total_latency_ms?: number;
    ttft_ms?: number;
    tpot_ms?: number;
    session_id?: string;
  };
  // chat.usage_summary fields
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  model?: string;
  usage_percent?: number;
  context_window_tokens?: number;
  session_id?: string;
  // chat.tool_update fields
  arguments?: string;
  status?: string;
  tool_call_id?: string;
}

// ── Store ─────────────────────────────────────────────────────────────────────

const ANALYSIS_LS_PREFIX = 'tracehound_analysis_';

function loadAnalysisFromStorage(sessionId: string): SessionAnalysis | null {
  try {
    const raw = localStorage.getItem(ANALYSIS_LS_PREFIX + sessionId);
    if (!raw) return null;
    return JSON.parse(raw) as SessionAnalysis;
  } catch { return null; }
}

function saveAnalysisToStorage(analysis: SessionAnalysis) {
  try {
    localStorage.setItem(ANALYSIS_LS_PREFIX + analysis.session_id, JSON.stringify(analysis));
  } catch { /* ignore quota errors */ }
}

interface TraceHoundState {
  sessions: TraceHoundSessionItem[];
  selectedSessionId: string | null;
  selectedSession: TraceHoundSessionItem | null;
  turns: TurnSummary[];
  sessionStats: SessionStats | null;
  selectedTurnId: string | null;
  turnRecords: HistoryRecord[];
  /** When a cross-link jumped into a turn, the record (by tool_call_id) to scroll to */
  focusRecordId: string | null;
  loading: boolean;
  error: string | null;

  // LLM analysis
  analysis: SessionAnalysis | null;
  analyzing: boolean;
  analyzeError: string | null;

  loadSessions: () => Promise<void>;
  selectSession: (session: TraceHoundSessionItem) => Promise<void>;
  /** Session-scoped entry for the chat's Trajectory panel — loads a session's
   *  turns directly by id (skips the global session browser). */
  openCurrentSession: (sessionId: string, title?: string, mode?: string | null) => Promise<void>;
  /** Live-refresh the open session's turn list + stats, preserving the
   *  selected turn (re-fetches its records only when its event_count grew). */
  refreshTurns: (sessionId: string) => Promise<void>;
  selectTurn: (turnId: string) => Promise<void>;
  /** Fetch + store a turn's records (shared by selectTurn and jumpToTurn). */
  loadTurnDetail: (turnId: string) => Promise<void>;
  /** Select a turn and request a scroll to the record matching `recordId`. */
  jumpToTurn: (turnId: string, recordId?: string) => void;
  back: () => void;
  clearError: () => void;
  analyzeSession: () => Promise<void>;
  clearAnalyzeError: () => void;
}

export const useTraceHoundStore = create<TraceHoundState>((set, get) => ({
  sessions: [],
  selectedSessionId: null,
  selectedSession: null,
  turns: [],
  sessionStats: null,
  selectedTurnId: null,
  turnRecords: [],
  focusRecordId: null,
  loading: false,
  error: null,

  analysis: null,
  analyzing: false,
  analyzeError: null,

  loadSessions: async () => {
    set({ loading: true, error: null });
    try {
      const res = await webRequest<{ sessions: TraceHoundSessionItem[] }>('session.list', {
        limit: 100,
      });
      const sessions = Array.isArray(res?.sessions) ? res.sessions : [];
      set({ sessions, loading: false });
      /* Background: for sessions where cached metadata lacks llm_calls/total_events,
         request lightweight stats.  The handler returns the full turn list anyway
         (no separate stats_only path), so we just use the normal endpoint. */
      const missing = sessions.filter(
        s => (s.llm_calls == null || s.total_events == null) && (s.round_id ?? 0) > 0
      );
      if (missing.length > 0) {
        missing.slice(0, 5).forEach(s => {
          webRequest<{ ok: boolean; session_stats: SessionStats }>(
            'tracehound.turns.list',
            { session_id: s.session_id }
          ).then(r => {
            if (r?.ok && r.session_stats) {
              const stats = r.session_stats;
              set(state => ({
                sessions: state.sessions.map(sess =>
                  sess.session_id === s.session_id
                     ? {
                        ...sess,
                        round_id: stats.total_turns ?? sess.round_id,
                        llm_calls: stats.total_llm_calls ?? sess.llm_calls,
                        total_events: stats.total_events ?? sess.total_events,
                        total_tokens: stats.total_tokens ?? sess.total_tokens,
                        error_count: stats.error_count ?? sess.error_count,
                        total_cache_tokens: stats.total_cache_tokens ?? sess.total_cache_tokens,
                        total_input_cost: stats.total_input_cost ?? sess.total_input_cost,
                        total_output_cost: stats.total_output_cost ?? sess.total_output_cost,
                        total_cost: stats.total_cost ?? sess.total_cost,
                        models_used: stats.models_used ?? sess.models_used,
                        avg_total_latency_ms: stats.avg_total_latency_ms ?? sess.avg_total_latency_ms,
                        avg_ttft_ms: stats.avg_ttft_ms ?? sess.avg_ttft_ms,
                        avg_tpot_ms: stats.avg_tpot_ms ?? sess.avg_tpot_ms,
                        max_context_usage_percent: stats.max_context_usage_percent ?? sess.max_context_usage_percent,
                        channel_id: stats.channel_id ?? sess.channel_id,
                      }
                    : sess
                ),
              }));
            }
          }).catch(() => {});
        });
      }
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  selectSession: async (session) => {
    // Load cached analysis from localStorage immediately so it shows while the
    // turn list is still loading (may be stale — staleness detected later).
    const cachedAnalysis = loadAnalysisFromStorage(session.session_id);
    set({
      loading: true,
      error: null,
      selectedSessionId: session.session_id,
      selectedSession: session,
      turns: [],
      sessionStats: null,
      selectedTurnId: null,
      turnRecords: [],
      focusRecordId: null,
      analysis: cachedAnalysis,
      analyzeError: null,
    });
    try {
      const res = await webRequest<{ ok: boolean; turns: TurnSummary[]; session_stats: SessionStats }>(
        'tracehound.turns.list',
        { session_id: session.session_id }
      );
      const turns = Array.isArray(res?.turns) ? res.turns : [];
      const sessionStats = res?.session_stats ?? null;
      set(state => ({
        turns,
        sessionStats,
        loading: false,
        // Merge computed stats into the session list immediately so the
        // user doesn't have to wait for the async backend metadata write.
        sessions: state.sessions.map(s =>
          s.session_id === session.session_id
            ? {
                ...s,
                round_id: sessionStats?.total_turns ?? s.round_id,
                llm_calls: sessionStats?.total_llm_calls ?? s.llm_calls,
                total_events: sessionStats?.total_events ?? s.total_events,
                total_tokens: sessionStats?.total_tokens ?? s.total_tokens,
                error_count: sessionStats?.error_count ?? s.error_count,
                total_cache_tokens: sessionStats?.total_cache_tokens ?? s.total_cache_tokens,
                total_input_cost: sessionStats?.total_input_cost ?? s.total_input_cost,
                total_output_cost: sessionStats?.total_output_cost ?? s.total_output_cost,
                total_cost: sessionStats?.total_cost ?? s.total_cost,
                models_used: sessionStats?.models_used ?? s.models_used,
                avg_total_latency_ms: sessionStats?.avg_total_latency_ms ?? s.avg_total_latency_ms,
                avg_ttft_ms: sessionStats?.avg_ttft_ms ?? s.avg_ttft_ms,
                avg_tpot_ms: sessionStats?.avg_tpot_ms ?? s.avg_tpot_ms,
                max_context_usage_percent: sessionStats?.max_context_usage_percent ?? s.max_context_usage_percent,
                channel_id: sessionStats?.channel_id ?? s.channel_id,
              }
            : s
        ),
      }));
      // Refresh session list so metadata caches are reflected (background)
      void get().loadSessions();
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  openCurrentSession: async (sessionId, title, mode) => {
    // Same flow as selectSession but with a minimal item constructed from the
    // currently open chat session — no need to go through the session browser.
    await get().selectSession({
      session_id: sessionId,
      title: title?.trim() || undefined,
      mode: mode || undefined,
    });
  },

  refreshTurns: async (sessionId) => {
    const prevEventCount = new Map(get().turns.map(t => [t.turn_id, t.event_count]));
    try {
      const res = await webRequest<{ ok: boolean; turns: TurnSummary[]; session_stats: SessionStats }>(
        'tracehound.turns.list',
        { session_id: sessionId }
      );
      const turns = Array.isArray(res?.turns) ? res.turns : [];
      const selectedTurnId = get().selectedTurnId;
      const selected = selectedTurnId ? turns.find(t => t.turn_id === selectedTurnId) : undefined;
      const selectedGrew = Boolean(
        selectedTurnId && (selected?.event_count ?? 0) > (prevEventCount.get(selectedTurnId) ?? 0)
      );
      set({
        turns,
        sessionStats: res?.session_stats ?? get().sessionStats,
        ...(selectedGrew ? { turnRecords: [] } : {}),
      });
      // Keep the detail view honest only when the selected turn actually grew —
      // reuses selectTurn's turn.get path to refresh its records.
      if (selectedGrew && selectedTurnId) {
        await get().selectTurn(selectedTurnId);
      }
    } catch {
      /* transient — next poll tick retries */
    }
  },

  selectTurn: async (turnId) => {
    const { selectedSessionId } = get();
    if (!selectedSessionId) return;
    set({ selectedTurnId: turnId, focusRecordId: null });
    await get().loadTurnDetail(turnId);
  },

  loadTurnDetail: async (turnId) => {
    const { selectedSessionId } = get();
    if (!selectedSessionId) return;
    set({ loading: true, error: null, turnRecords: [] });
    try {
      const res = await webRequest<{ ok: boolean; records: HistoryRecord[] }>(
        'tracehound.turn.get',
        { session_id: selectedSessionId, turn_id: turnId }
      );
      const records = (Array.isArray(res?.records) ? res.records : []).sort(
        (a, b) => a.timestamp - b.timestamp
      );
      set({ turnRecords: records, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  jumpToTurn: (turnId, recordId) => {
    set({ selectedTurnId: turnId, focusRecordId: recordId ?? null });
    void get().loadTurnDetail(turnId);
  },

  back: () => {
    const { selectedTurnId } = get();
    if (selectedTurnId) {
      set({ selectedTurnId: null, turnRecords: [], focusRecordId: null });
    } else {
      set({ selectedSessionId: null, selectedSession: null, turns: [], sessionStats: null, analysis: null, analyzeError: null });
    }
  },

  clearError: () => set({ error: null }),

  analyzeSession: async () => {
    const { selectedSessionId, analyzing } = get();
    if (!selectedSessionId || analyzing) return;
    set({ analyzing: true, analyzeError: null });
    try {
      const res = await webRequest<{
        ok: boolean;
        issues: AnalysisIssue[];
        fingerprint: string;
        analyzed_at: number;
        error?: string;
      }>('tracehound.analyze', { session_id: selectedSessionId }, { timeoutMs: 1_200_000 });

      if (!res?.ok) {
        set({ analyzing: false, analyzeError: res?.error ?? 'Analysis failed' });
        return;
      }

      const analysis: SessionAnalysis = {
        session_id: selectedSessionId,
        fingerprint: res.fingerprint ?? '',
        analyzed_at: res.analyzed_at ?? Date.now() / 1000,
        issues: Array.isArray(res.issues) ? res.issues : [],
      };
      saveAnalysisToStorage(analysis);
      set({ analyzing: false, analysis });
    } catch (e) {
      set({ analyzing: false, analyzeError: String(e) });
    }
  },

  clearAnalyzeError: () => set({ analyzeError: null }),
}));
