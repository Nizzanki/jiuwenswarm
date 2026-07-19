// Inkwell Studio controller.
//
// The UI renders entirely from `state`, which is mutated by apply(event). Events arrive
// from an event source with a start(onEvent)/stop() interface. Phase 1: SimEventSource
// (a scripted timeline). Phase 2: A2AEventSource (SSE from the bridge, which runs a real
// JiuwenSwarm story over A2A). Both emit the SAME event shape, so the reducer/renderers
// below are identical for simulated and live runs.

import { buildTimeline, AGENT_LABELS } from './sim/timeline.js';

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------- event sources ------------------------------ */
// Interface: start(onEvent) begins emitting; stop() cancels.
class SimEventSource {
  constructor(seq) { this.seq = seq; this.timers = []; }
  start(onEvent) {
    for (const { at, event } of this.seq) {
      this.timers.push(setTimeout(() => onEvent(event), at));
    }
  }
  stop() { this.timers.forEach(clearTimeout); this.timers = []; }
}

// Live source: subscribes to the bridge's SSE endpoint, which streams the same
// normalized events parsed from a real swarm run over A2A.
class A2AEventSource {
  constructor(brief, { onFatal } = {}) {
    this.brief = brief; this.onFatal = onFatal; this.es = null; this.got = 0; this.done = false;
  }
  start(onEvent) {
    const q = new URLSearchParams({
      idea: this.brief.idea, style: this.brief.style, panels: String(this.brief.total),
    });
    let es;
    try { es = new EventSource(`/events?${q.toString()}`); }
    catch { this.onFatal && this.onFatal('Could not open a live connection.'); return; }
    this.es = es;
    es.onmessage = (e) => {
      let ev; try { ev = JSON.parse(e.data); } catch { return; }
      this.got += 1;
      if (ev.t === 'error') { onEvent({ t: 'agent', id: 'editor', status: 'reject', say: ev.message }); return; }
      if (ev.t === 'run.done') this.done = true;
      onEvent(ev);
      if (this.done) this.stop();
    };
    es.onerror = () => {
      if (this.done) { this.stop(); return; }              // normal close after run.done
      this.stop();
      if (this.got === 0) this.onFatal && this.onFatal('Live bridge not reachable — is server/bridge.py running?');
      else onEvent({ t: 'run.done' });                     // mid-stream drop: end the run cleanly
    };
  }
  stop() { if (this.es) { this.es.close(); this.es = null; } }
}

/* --------------------------------- the state -------------------------------- */

const AGENT_ORDER = ['writer', 'critic', 'artDirector', 'imageGen', 'editor'];
const AGENT_NAMES = {
  writer: 'Writer', critic: 'Critic', artDirector: 'Art Director',
  imageGen: 'Image Gen', editor: 'Editor',
};
const STATE_WORD = { active: 'working', done: 'done', idle: 'idle', reject: 'rejected' };

function freshAgents() {
  return {
    writer:      { status: 'idle', say: 'Ready when you are.' },
    critic:      { status: 'idle', say: 'Standing by to review.' },
    artDirector: { status: 'idle', say: 'Waiting for the first beat.' },
    imageGen:    { status: 'idle', say: 'No panels rendered yet.' },
    editor:      { status: 'idle', say: 'Watching the flow.' },
  };
}

function freshState() {
  return {
    brief: { idea: '', style: '', total: 5 },
    panels: [],            // { n, status, caption, dim, svg, note }
    agents: freshAgents(),
    progress: { approved: 0, inReview: 0, drafting: 0, total: 5 },
    focus: null,
    log: [],
    running: false,
    done: false,
  };
}

let state = freshState();
let source = null;
const typers = {};         // panel n -> { cancelled } token for the caption typewriter

/* ---------------------------------- reducer --------------------------------- */

function apply(ev) {
  switch (ev.t) {
    case 'brief':
      state.brief = { idea: ev.idea, style: ev.style, total: ev.total };
      renderBrief();
      break;

    case 'panel.status': {
      const p = ensurePanel(ev.panel);
      p.status = ev.status;
      if (ev.status === 'approved') p.note = null;   // clear the kickback note once resolved
      renderPanel(p.n);
      break;
    }
    case 'panel.art': {
      const p = ensurePanel(ev.panel);
      p.svg = ev.svg;
      renderPanel(p.n);
      break;
    }
    case 'panel.image': {
      const p = ensurePanel(ev.panel);
      p.image = ev.src;                 // bridge-rendered picture (data URI)
      renderPanel(p.n);
      break;
    }
    case 'panel.caption': {
      const p = ensurePanel(ev.panel);
      p.caption = ev.text; p.dim = !!ev.dim;
      renderPanel(p.n);
      typeCaption(p.n);          // animate the freshly-arrived caption
      break;
    }
    case 'panel.note': {
      const p = ensurePanel(ev.panel);
      p.note = { label: ev.label, text: ev.text };
      renderPanel(p.n);
      break;
    }

    case 'agent': {
      const a = state.agents[ev.id];
      if (a) { a.status = ev.status; a.say = ev.say; if (ev.state) a.state = ev.state; else delete a.state; }
      renderCrew();
      break;
    }

    case 'progress':
      state.progress = { approved: ev.approved, inReview: ev.inReview, drafting: ev.drafting, total: ev.total };
      renderProgress();
      break;

    case 'focus':
      state.focus = ev.panel;
      renderLog();
      break;

    case 'log':
      state.log.push({ step: ev.step, html: ev.html });
      renderLog();
      break;

    case 'run.done':
      finishRun();
      break;
  }
}

function ensurePanel(n) {
  let p = state.panels.find((x) => x.n === n);
  if (!p) { p = { n, status: 'drafting', caption: '', dim: true, svg: '', image: '', note: null }; state.panels.push(p); state.panels.sort((a, b) => a.n - b.n); }
  return p;
}

/* --------------------------------- rendering -------------------------------- */

const $ = (id) => document.getElementById(id);

function renderBrief() {
  $('brief-q').textContent = `“${state.brief.idea}”`;
  const tags = state.brief.style.split('·').map((s) => s.trim()).filter(Boolean);
  tags.push(`~${state.brief.total} panels`);
  $('brief-tags').innerHTML = tags.map((t) => `<span>${escapeHtml(t)}</span>`).join('');
}

const PILL = {
  drafting:  { cls: 'draft',  text: 'Drafting' },
  rendering: { cls: 'draft',  text: 'Rendering' },
  review:    { cls: 'review', text: 'In review' },
  revising:  { cls: 'review', text: 'In review' },
  approved:  { cls: 'ok',     text: 'Approved' },
};

function panelInnerHtml(p) {
  const pill = PILL[p.status] || PILL.drafting;
  const num = String(p.n).padStart(2, '0');
  const revising = p.status === 'revising';

  const revTag = revising ? '<span class="rev-tag">Revising…</span>' : '';
  let media;
  if (p.image) {
    media = `<img class="pimg-img" src="${p.image}" alt="${escapeHtml(p.caption || 'panel image')}">` + revTag;
  } else if (p.svg && /^\s*<svg/i.test(p.svg)) {
    media = p.svg + revTag;                                   // simulated: inline SVG art
  } else if (p.svg) {
    // live: panel.art is the Art Director's image prompt; a real picture pops in when ready
    const rendering = (p.status === 'review' || p.status === 'approved' || p.status === 'revising')
      ? '<div class="rendering">rendering…</div>' : '';
    media = `<div class="artprompt">${rendering}<div class="k">Art Director · image prompt</div>`
      + `<div class="p">“${escapeHtml(p.svg)}”</div><div class="tag">🎨 image prompt</div></div>` + revTag;
  } else {
    const lb = p.status === 'rendering' ? 'Rendering…' : 'Writer at work…';
    media = `<div class="skel"><div class="ic"></div><div class="lb">${lb}</div></div>`;
  }

  const capText = p.caption ? escapeHtml(p.caption) : '— caption pending —';
  const capClass = p.caption && !p.dim ? 't' : 't dim';
  const note = p.note
    ? `<div class="note"><b>${escapeHtml(p.note.label)}</b>${escapeHtml(p.note.text)}</div>`
    : '';

  return `
    <div class="pimg${revising ? ' revising' : ''}">
      <span class="pill ${pill.cls}">${pill.text}</span><span class="pnum">${num}</span>
      ${media}
    </div>
    <div class="pcap"><div class="${capClass}">${capText}</div>${note}</div>`;
}

function renderPanel(n) {
  cancelTyper(n);            // any in-flight typewriter is stale once we rebuild the card
  const p = state.panels.find((x) => x.n === n);
  if (!p) return;
  const gallery = $('gallery');
  const empty = $('gallery-empty');
  if (empty) empty.remove();

  let el = document.getElementById(`panel-${n}`);
  if (!el) {
    el = document.createElement('div');
    el.className = 'pcard enter';
    el.id = `panel-${n}`;
    // insert in panel-number order
    const after = state.panels.filter((x) => x.n < n).pop();
    const ref = after ? document.getElementById(`panel-${after.n}`) : null;
    if (ref && ref.nextSibling) gallery.insertBefore(el, ref.nextSibling);
    else gallery.appendChild(el);
    if (!REDUCED_MOTION) el.addEventListener('animationend', () => el.classList.remove('enter'), { once: true });
  }
  el.innerHTML = panelInnerHtml(p);
}

function renderCrew() {
  const html = AGENT_ORDER.map((id) => {
    const a = state.agents[id];
    const dot = { active: 'active', reject: 'reject', done: 'done', idle: 'idle' }[a.status] || 'idle';
    const word = a.state || STATE_WORD[a.status] || 'idle';
    const stCls = { active: 'st-active', reject: 'st-reject', done: 'st-done', idle: 'st-idle' }[a.status] || 'st-idle';
    const tool = AGENT_LABELS[id] ? ` <small>${AGENT_LABELS[id]}</small>` : '';
    return `
      <div class="agent">
        <span class="dot ${dot}"></span>
        <div style="flex:1">
          <div class="row1"><span class="who">${AGENT_NAMES[id]}${tool}</span><span class="state ${stCls}">${escapeHtml(word)}</span></div>
          <div class="say">${escapeHtml(a.say)}</div>
        </div>
      </div>`;
  }).join('');
  $('crew').innerHTML = html;
}

function renderProgress() {
  const { approved, inReview, drafting, total } = state.progress;
  const pct = Math.round((approved / total) * 100);
  $('prog-bar').style.width = `${pct}%`;
  if (state.done) {
    $('prog-lead').textContent = 'Story complete';
    $('prog-sub').textContent = `· all ${total} panels approved`;
  } else if (state.running) {
    $('prog-lead').textContent = `${approved} approved`;
    $('prog-sub').textContent = `· ${inReview} in review · ${drafting} drafting · ~${total} total`;
  } else {
    $('prog-lead').textContent = 'Idle';
    $('prog-sub').textContent = '· press Go to begin';
  }
}

function renderLog() {
  const title = $('loop-title');
  const list = $('log');
  if (state.focus == null || state.log.length === 0) {
    title.textContent = 'Revision loop';
    list.innerHTML = '<li class="log-empty"><span class="txt">The Critic↔Writer loop shows up here when a panel gets sent back.</span></li>';
    return;
  }
  title.textContent = `Panel ${state.focus}`;
  list.innerHTML = state.log
    .map((l) => `<li><span class="step">${escapeHtml(String(l.step))}</span><span class="txt">${sanitizeLogHtml(l.html)}</span></li>`)
    .join('');
}

// Log entries may be model-generated HTML (live mode). Allow only a tiny safe subset
// (<b>/<i>/<em>/<strong> and <span class="bad|live">); strip everything else. Parsing
// into a <template> is inert — no scripts run, no resources load.
function sanitizeLogHtml(html) {
  const ALLOWED = { B: [], I: [], EM: [], STRONG: [], SPAN: ['class'] };
  const OK_SPAN_CLASS = new Set(['bad', 'live']);
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html == null ? '' : html);
  const walk = (node) => {
    [...node.childNodes].forEach((c) => {
      if (c.nodeType === 8) { c.remove(); return; }           // comments
      if (c.nodeType !== 1) return;                            // keep text
      const allowedAttrs = ALLOWED[c.tagName];
      if (!allowedAttrs) { c.replaceWith(...c.childNodes); return; }  // unwrap disallowed tag
      [...c.attributes].forEach((a) => { if (!allowedAttrs.includes(a.name)) c.removeAttribute(a.name); });
      if (c.tagName === 'SPAN' && !OK_SPAN_CLASS.has(c.getAttribute('class'))) c.removeAttribute('class');
      walk(c);
    });
  };
  walk(tpl.content);
  return tpl.innerHTML;
}

function renderAll() {
  renderBrief(); renderCrew(); renderProgress(); renderLog();
}

/* ------------------------------ caption typewriter -------------------------- */

function cancelTyper(n) { if (typers[n]) { typers[n].cancelled = true; delete typers[n]; } }

function typeCaption(n) {
  const el = document.querySelector(`#panel-${n} .pcap .t`);
  const p = state.panels.find((x) => x.n === n);
  if (!el || !p || !p.caption) return;
  const full = p.caption;
  if (REDUCED_MOTION) { el.textContent = full; return; }

  const token = { cancelled: false };
  typers[n] = token;
  let i = 0;
  const caret = '<span class="caret"></span>';
  const step = () => {
    if (token.cancelled) return;
    i += 1;
    el.innerHTML = escapeHtml(full.slice(0, i)) + (i < full.length ? caret : '');
    if (i < full.length) setTimeout(step, 20);
    else { el.textContent = full; if (typers[n] === token) delete typers[n]; }
  };
  el.innerHTML = caret;
  setTimeout(step, 20);
}

/* --------------------------------- run control ------------------------------ */

let LIVE = false;   // false = Simulated (SimEventSource), true = Live (A2AEventSource)

function startRun() {
  stopRun();
  state = freshState();

  const idea = ($('idea').value || '').trim() || 'A lonely lighthouse keeper befriends a sea monster.';
  const style = $('style').value;
  const total = parseInt($('count').value, 10) || 5;
  state.brief = { idea, style, total };
  state.running = true;

  // reset the view
  const wait = LIVE
    ? 'Contacting the JiuwenSwarm crew over A2A… first panels take ~20–40s while the story is written.'
    : 'Sending the brief to the crew…';
  $('gallery').innerHTML = `<div class="empty" id="gallery-empty">${wait}</div>`;
  renderAll();
  $('crew-live').textContent = 'live';

  setInputsDisabled(true);
  $('download').disabled = true;
  $('download-gif').disabled = true;
  const go = $('go');
  go.textContent = 'Running…'; go.classList.add('running'); go.classList.remove('again'); go.disabled = true;

  source = LIVE
    ? new A2AEventSource(state.brief, { onFatal: fallbackToSim })
    : new SimEventSource(buildTimeline(state.brief));
  source.start(apply);
}

// If the live bridge can't be reached, keep the demo alive: note it and run simulated.
function fallbackToSim(msg) {
  stopRun();
  showLiveNote(`${msg} Falling back to the simulated run.`);
  source = new SimEventSource(buildTimeline(state.brief));
  source.start(apply);
}

function showLiveNote(text) {
  const gallery = $('gallery');
  let note = document.getElementById('livenote');
  if (!note) {
    note = document.createElement('div');
    note.className = 'livenote'; note.id = 'livenote';
    gallery.prepend(note);
  }
  note.textContent = `⚠ ${text}`;
}

function finishRun() {
  state.running = false; state.done = true;
  renderProgress();
  $('crew-live').textContent = 'done';
  const go = $('go');
  go.textContent = 'Run again'; go.classList.remove('running'); go.classList.add('again'); go.disabled = false;
  setInputsDisabled(false);
  const hasStory = state.panels.filter((p) => p.caption).length > 0;
  $('download').disabled = !hasStory;
  $('download-gif').disabled = !hasStory;
}

function stopRun() {
  if (source) { source.stop(); source = null; }
  Object.keys(typers).forEach(cancelTyper);
}

function setInputsDisabled(disabled) {
  ['idea', 'style', 'count', 'mode-sim', 'mode-live'].forEach((id) => { $(id).disabled = disabled; });
}

function setMode(live) {
  LIVE = live;
  $('mode-sim').classList.toggle('active', !live);
  $('mode-live').classList.toggle('active', live);
}

/* ---------------------------------- helpers --------------------------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* --------------------------- download story (export) ------------------------ */
// Self-contained HTML: title/brief + each panel's art (image data URI or inline SVG or
// the prompt) + serif caption, styled in the studio look. Works for both engines.
function buildStoryHtml() {
  const b = state.brief;
  const panels = state.panels.filter((p) => p.caption);
  const figures = panels.map((p) => {
    let art;
    if (p.image) art = `<img src="${p.image}" alt="">`;
    else if (p.svg && /^\s*<svg/i.test(p.svg)) art = p.svg;
    else art = `<div class="ph">“${escapeHtml(p.svg || '')}”</div>`;
    return `<figure><div class="art">${art}</div><figcaption>${escapeHtml(p.caption)}</figcaption></figure>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(b.idea)} — Inkwell Studio</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#11131a;color:#eceef2;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.5}
  .wrap{max-width:760px;margin:0 auto;padding:48px 20px 64px}
  header{border-bottom:1px solid #2f3542;padding-bottom:20px;margin-bottom:28px}
  h1{font-size:13px;letter-spacing:.2em;text-transform:uppercase;color:#38b3a4;margin:0 0 12px}
  .idea{font-family:Georgia,serif;font-style:italic;font-size:24px;margin:0}
  .style{color:#99a1b0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;margin-top:8px;letter-spacing:.04em}
  figure{margin:0 0 34px;border:1px solid #2f3542;border-radius:12px;overflow:hidden;background:#171a22}
  .art,.art svg,.art img{display:block;width:100%;height:auto;line-height:0}
  .ph{aspect-ratio:16/10;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;
      font-family:Georgia,serif;font-style:italic;color:#99a1b0;background:linear-gradient(180deg,#1e222c,#171a22)}
  figcaption{font-family:Georgia,serif;font-size:16px;padding:16px 18px 20px}
  footer{margin-top:12px;color:#6a7382;font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.08em;text-align:center}
</style></head><body><div class="wrap">
<header><h1>Inkwell Studio</h1><p class="idea">“${escapeHtml(b.idea)}”</p><p class="style">${escapeHtml(b.style)} · ${panels.length} panels</p></header>
<main>${figures}</main>
<footer>An illustrated story, made by a crew of agents · powered by JiuwenSwarm over A2A</footer>
</div></body></html>`;
}

function storySlug() {
  return (state.brief.idea || 'story').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'story';
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function downloadStory() {
  triggerDownload(new Blob([buildStoryHtml()], { type: 'text/html' }), `inkwell-${storySlug()}.html`);
}

/* --------------------------- download GIF (animatic) ------------------------ */
// Rasterize a panel's art (inline SVG, a rendered image, or the prompt placeholder)
// to a PNG data URI via canvas, so the bridge (Pillow) can assemble the GIF.
function panelArtToPng(p) {
  return new Promise((resolve) => {
    const W = 640, Hh = 400;
    const draw = (drawer) => {
      const c = document.createElement('canvas'); c.width = W; c.height = Hh;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#f0e8d5'; ctx.fillRect(0, 0, W, Hh);   // paper backing
      drawer(ctx);
      try { resolve(c.toDataURL('image/png')); } catch { resolve(null); }
    };
    let src = null;
    if (p.image) {
      src = p.image;
    } else if (p.svg && /^\s*<svg/i.test(p.svg)) {
      // Inline panel SVGs omit xmlns + size (fine in the DOM, but loading one as a
      // standalone image parses it as XML and needs both — else it fails / draws blank).
      let svg = p.svg;
      if (!/\bxmlns=/i.test(svg)) svg = svg.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
      if (!/<svg[^>]*\bwidth=/i.test(svg)) svg = svg.replace(/<svg/i, `<svg width="${W}" height="${Hh}"`);
      src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    }
    if (src) {
      const img = new Image();
      img.onload = () => draw((ctx) => ctx.drawImage(img, 0, 0, W, Hh));
      img.onerror = () => resolve(null);
      img.src = src;
    } else {
      // prompt placeholder → render the prompt text on a paper card
      draw((ctx) => {
        ctx.fillStyle = '#f0e8d5'; ctx.fillRect(0, 0, W, Hh);
        ctx.fillStyle = '#6a6051'; ctx.font = 'italic 20px Georgia, serif';
        wrapText(ctx, `“${(p.svg || 'image pending')}”`, 40, 60, W - 80, 28);
      });
    }
  });
}

function wrapText(ctx, text, x, y, maxW, lh) {
  const words = String(text).split(' '); let line = '';
  for (const w of words) {
    const t = line + w + ' ';
    if (ctx.measureText(t).width > maxW && line) { ctx.fillText(line, x, y); line = w + ' '; y += lh; }
    else line = t;
  }
  ctx.fillText(line, x, y);
}

async function downloadGif() {
  const btn = $('download-gif');
  if (btn.disabled) return;
  const label = btn.textContent;
  btn.classList.add('busy'); btn.textContent = '⟳ Rendering GIF…'; btn.disabled = true;
  try {
    const panels = state.panels.filter((p) => p.caption);
    const out = [];
    for (const p of panels) {                      // rasterize sequentially (concurrent
      out.push({ n: p.n, caption: p.caption, png: await panelArtToPng(p) });  // loads can race)
    }
    const payload = { idea: state.brief.idea, style: state.brief.style, panels: out };
    const res = await fetch('/export/gif', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`bridge ${res.status}`);
    triggerDownload(await res.blob(), `inkwell-${storySlug()}.gif`);
  } catch (e) {
    showLiveNote(`Couldn't build the GIF (${e.message}). GIF export needs the bridge running.`);
  } finally {
    btn.classList.remove('busy'); btn.textContent = label; btn.disabled = false;
  }
}

/* ----------------------------------- boot ----------------------------------- */

$('promptbar').addEventListener('submit', (e) => {
  e.preventDefault();
  if (state.running) return;
  startRun();
});

$('mode-sim').addEventListener('click', () => { if (!state.running) setMode(false); });
$('mode-live').addEventListener('click', () => { if (!state.running) setMode(true); });
$('download').addEventListener('click', () => { if (!$('download').disabled) downloadStory(); });
$('download-gif').addEventListener('click', downloadGif);

// Default to Live when served by the bridge (http origin) with ?live=1; else Simulated.
const params = new URLSearchParams(location.search);
setMode(params.get('live') === '1');

renderAll();   // show the idle crew / progress on load

// dev/demo aid: open with ?autorun=1 to start a run immediately on load
if (params.has('autorun')) startRun();

// small automation/debug hook (export + state), used by verification tooling
window.__inkwell = { buildStoryHtml, downloadStory, downloadGif, panelArtToPng, getState: () => state };
