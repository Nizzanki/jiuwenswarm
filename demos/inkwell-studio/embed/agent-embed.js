// AgentEmbedSource -- the reusable half of driving a JiuwenSwarm agent/team over A2A from a
// browser. Everything else in this demo's app.js (the reducer, panel rendering, narration,
// exports) is genuinely Inkwell-specific; this class is not -- it's a thin SSE client with
// a start(onEvent)/stop() interface, extracted unchanged (behaviorally) from the app.js this
// demo shipped with, plus auth-token support for a bridge that requires one.
//
// A different app driving its own agent/team over the same a2a_embed-based bridge pattern
// (packages/a2a-embed/) can reuse this file as-is: swap `params`/`onEvent` for its own query
// shape and event vocabulary, point `eventsPath` at its own bridge's SSE endpoint.
//
// Interface: start(onEvent) begins emitting; stop() cancels. Query params are opaque to this
// class -- pass whatever your bridge's SSE endpoint expects.
export class AgentEmbedSource {
  constructor(params, { onFatal, token, eventsPath = '/events' } = {}) {
    this.params = params; this.onFatal = onFatal; this.token = token; this.eventsPath = eventsPath;
    this.es = null; this.got = 0; this.done = false;
  }
  start(onEvent) {
    const q = new URLSearchParams(this.params);
    // Browsers' native EventSource can't set custom headers, so a bridge that requires
    // auth (a2a_embed.server.sse_route's token_env_var) is checked via this query param
    // instead -- see packages/a2a-embed/a2a_embed/auth.py's docstring for the tradeoff.
    if (this.token) q.set('token', this.token);
    let es;
    try { es = new EventSource(`${this.eventsPath}?${q.toString()}`); }
    catch { this.onFatal && this.onFatal('Could not open a live connection.'); return; }
    this.es = es;
    es.onmessage = (e) => {
      let ev; try { ev = JSON.parse(e.data); } catch { return; }
      this.got += 1;
      if (ev.t === 'run.done') this.done = true;
      onEvent(ev);
      if (this.done) this.stop();
    };
    es.onerror = () => {
      if (this.done) { this.stop(); return; }              // normal close after run.done
      this.stop();
      if (this.got === 0) this.onFatal && this.onFatal(`Live bridge not reachable at ${this.eventsPath}.`);
      else onEvent({ t: 'run.done' });                     // mid-stream drop: end the run cleanly
    };
  }
  stop() { if (this.es) { this.es.close(); this.es = null; } }
}
