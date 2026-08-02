// Inkwell Studio controller.
//
// The UI renders entirely from `state`, which is mutated by apply(event). Events arrive
// from an event source with a start(onEvent)/stop() interface: A2AEventSource (SSE from the
// bridge, which runs a real JiuwenSwarm story over A2A).

const AGENT_LABELS = { imageGen: 'tool' };

// Canned, child-safe one-liners for the "surprise me" idea button — purely client-side,
// no LLM call needed for something this small.
const SURPRISE_IDEAS = [
  'A lonely lighthouse keeper befriends a sea monster.',
  'A shy dragon just wants someone to read books with.',
  'A little cloud loses her rain and asks the animals for help.',
  'A snail dreams of racing the wind and finally gets his chance.',
  'A grumpy old oak tree learns to share its shade with a new sapling.',
  'A firefly who can\'t glow yet borrows light from the stars.',
  'Two rival garden gnomes team up to save the vegetable patch.',
  'A young otter finds a lost mitten and searches the whole river for its owner.',
  'A sleepy bear tries to stay awake to see the first snow.',
  'A paper boat sets sail to find where the stream ends.',
  'A tiny mole who\'s afraid of the dark discovers she can glow.',
  'A young owl is scared of heights but must learn to fly before winter.',
  'A scarecrow secretly longs to dance with the cornstalks at night.',
  'A hedgehog too prickly for hugs invents a soft blanket instead.',
  'A whale sings the same song every night, hoping someone finally sings back.',
];

function surpriseIdea() {
  if (state.running) return;
  const field = $('idea');
  const pool = SURPRISE_IDEAS.filter((s) => s !== field.value);
  field.value = pool[Math.floor(Math.random() * pool.length)];
}

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* --------------------------------- read-aloud narration ----------------------------------- */
// Browser-native SpeechSynthesis — no backend, no cost, no setup. Panels arrive progressively
// over SSE and each one's caption reveal is already paced, so a small FIFO queue keeps
// utterances spoken one at a time in panel order instead of overlapping/racing if two panels
// settle close together.
const SPEECH_SUPPORTED = 'speechSynthesis' in window;
let narrationOn = false;   // live narration off by default (no toggle in the UI); "Read story aloud" bypasses this
const narrateQueue = [];
let narrating = false;
let narrateOnIdle = null;   // fires once when the queue fully drains (see readStoryAloud)

function narratePump() {
  if (narrating) return;
  if (!narrateQueue.length) {
    if (narrateOnIdle) { const fn = narrateOnIdle; narrateOnIdle = null; fn(); }
    return;
  }
  narrating = true;
  const utter = new SpeechSynthesisUtterance(narrateQueue.shift());
  utter.rate = 0.92;   // a touch slower than default — easier to follow as a read-aloud story
  utter.onend = utter.onerror = () => { narrating = false; narratePump(); };
  speechSynthesis.speak(utter);
}

function narrateEnqueue(text) {
  if (!narrationOn || !SPEECH_SUPPORTED || !text) return;
  narrateQueue.push(text);
  narratePump();
}

function narrateStop() {
  narrateQueue.length = 0;
  narrating = false;
  narrateOnIdle = null;
  if (SPEECH_SUPPORTED) speechSynthesis.cancel();
}

/* ------------------------------- event source -------------------------------- */
// Interface: start(onEvent) begins emitting; stop() cancels.
// Subscribes to the bridge's SSE endpoint, which streams normalized events parsed from a
// real swarm run over A2A.
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
      if (ev.status === 'approved') {                // clear the kickback note once resolved,
        if (p.note) p.pastNote = p.note;             // but keep it for the debug section
        p.note = null;
        // Read the FINISHED line aloud — triggering off "approved" (not panel.caption)
        // means a rejected draft never gets narrated, only whatever the caption reads by
        // the time the panel actually lands (the revised text, if it was sent back).
        if (p.caption) narrateEnqueue(p.caption);
      }
      renderPanel(p.n);
      break;
    }
    case 'panel.art': {
      const p = ensurePanel(ev.panel);
      // A different prompt means the panel is being re-done (the Critic sent it back):
      // archive the outgoing prompt + the image that was rendered for it, so the debug
      // section can show rejected-vs-approved. (p.image still holds the OLD render here,
      // because the new image event always follows its art event.)
      if (p.svg && p.svg !== ev.svg) p.artHistory.push({ svg: p.svg, image: p.image });
      p.svg = ev.svg;
      p.imageError = null;       // a new prompt means a fresh render is starting
      renderPanel(p.n);
      break;
    }
    case 'panel.image': {
      const p = ensurePanel(ev.panel);
      p.image = ev.src;                 // bridge-rendered picture (data URI)
      p.imageError = null;              // a retry/revision succeeded — clear any earlier failure
      renderPanel(p.n);
      break;
    }
    case 'panel.image.failed': {
      const p = ensurePanel(ev.panel);
      if (!p.image) p.imageError = ev.reason || 'render failed';   // keep a picture we already have
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
      // the caption that was on the panel when the Critic rejected it
      if (p.rejectedCaption == null) p.rejectedCaption = p.caption;
      renderPanel(p.n);
      break;
    }

    case 'agent': {
      const a = state.agents[ev.id];
      // Live-forwarded status updates (bridge.py's _live_view) send say:"" — the status dot
      // still needs to update immediately, but an empty line shouldn't blank out whatever
      // text is already showing; the real line follows once the run's text is corrected.
      if (a) { a.status = ev.status; if (ev.say) a.say = ev.say; if (ev.state) a.state = ev.state; else delete a.state; }
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
  if (!p) {
    p = { n, status: 'drafting', caption: '', dim: true, svg: '', image: '', imageError: null,
          note: null, artHistory: [], rejectedCaption: null, regenerating: false };
    state.panels.push(p); state.panels.sort((a, b) => a.n - b.n);
  }
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

// No entry for "approved" — once a panel lands, its status badge is removed rather than
// left reading "Approved" over the finished picture.
const PILL = {
  drafting:  { cls: 'draft',  text: 'Drafting' },
  rendering: { cls: 'draft',  text: 'Rendering' },
  review:    { cls: 'review', text: 'In review' },
  revising:  { cls: 'review', text: 'In review' },
};

function panelInnerHtml(p) {
  const pill = PILL[p.status] || null;
  const num = String(p.n).padStart(2, '0');
  const revising = p.status === 'revising';

  const revTag = revising ? '<span class="rev-tag">Revising…</span>' : '';
  let media;
  if (p.image) {
    media = `<img class="pimg-img" src="${p.image}" alt="${escapeHtml(p.caption || 'panel image')}">` + revTag;
  } else if (p.svg) {
    // panel.art is the Art Director's image prompt; a real picture pops in when ready.
    // If the render failed we say so — an endless "rendering…" is a lie.
    let rendering = '';
    if (p.imageError) {
      rendering = `<div class="failed" title="${escapeHtml(p.imageError)}">no image</div>`;
    } else if (p.status === 'review' || p.status === 'approved' || p.status === 'revising') {
      rendering = '<div class="rendering">rendering…</div>';
    }
    media = `<div class="artprompt">${rendering}<div class="k">Art Director · image prompt</div>`
      + `<div class="p">“${escapeHtml(p.svg)}”</div>`
      + `<div class="tag${p.imageError ? ' bad' : ''}">`
      + (p.imageError ? `⚠ ${escapeHtml(p.imageError)}` : '🎨 image prompt')
      + `</div></div>` + revTag;
  } else {
    const lb = p.status === 'rendering' ? 'Rendering…' : 'Writer at work…';
    media = `<div class="skel"><div class="ic"></div><div class="lb">${lb}</div></div>`;
  }

  const capText = p.caption ? escapeHtml(p.caption) : '— caption pending —';
  const capClass = p.caption && !p.dim ? 't' : 't dim';
  const note = p.note
    ? `<div class="note"><b>${escapeHtml(p.note.label)}</b>${escapeHtml(p.note.text)}</div>`
    : '';

  // Redo this one panel's picture — same caption/prompt, a fresh render. Only offered once
  // there's a prompt to render from and the crew isn't actively mid-run (during a run the
  // panel is still being written/rendered for the first time, so "redo" doesn't apply yet).
  const canRegen = !!p.svg && !state.running;
  const regenBtn = canRegen
    ? `<button type="button" class="regen-btn" data-panel="${p.n}" ${p.regenerating ? 'disabled' : ''}
         title="Redo this image — same caption, a fresh picture">${p.regenerating ? '⟳ Redrawing…' : '↻ Redo image'}</button>`
    : '';

  return `
    <div class="pimg${revising ? ' revising' : ''}">
      ${pill ? `<span class="pill ${pill.cls}">${pill.text}</span>` : ''}<span class="pnum">${num}</span>
      ${media}
      ${regenBtn}
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
  renderFullText();          // keep the full-text / debug section in step with the panels
}

function renderCrew() {
  const html = AGENT_ORDER.map((id) => {
    const a = state.agents[id];
    const dot = { active: 'active', reject: 'reject', done: 'done', idle: 'idle' }[a.status] || 'idle';
    const word = a.state || STATE_WORD[a.status] || 'idle';
    const stCls = { active: 'st-active', reject: 'st-reject', done: 'st-done', idle: 'st-idle' }[a.status] || 'st-idle';
    const tool = AGENT_LABELS[id] ? ` <small>${AGENT_LABELS[id]}</small>` : '';
    return `
      <div class="agent${a.status === 'active' ? ' agent-active' : ''}">
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

// The finished story as continuous prose + a per-panel debug breakdown.
function renderFullText() {
  const story = $('ft-story'), meta = $('ft-meta'), dbg = $('ft-debug');
  if (!story) return;
  const panels = state.panels.filter((p) => p.caption).sort((a, b) => a.n - b.n);
  if (!panels.length) {
    story.innerHTML = '<span class="ft-empty">The finished story appears here once a run completes.</span>';
    meta.textContent = '—'; dbg.innerHTML = '';
    return;
  }
  const words = panels.reduce((n, p) => n + p.caption.split(/\s+/).filter(Boolean).length, 0);
  meta.textContent = `${panels.length} panel${panels.length > 1 ? 's' : ''} · ${words} words`;
  story.innerHTML = panels.map((p) => `<p>${escapeHtml(p.caption)}</p>`).join('');
  // `svg` holds the Art Director's text image prompt (show the words as the thumbnail's caption).
  const thumb = (svg, image) => {
    if (image) return `<img src="${image}" alt="">`;
    return '<div class="ft-noimg">no image</div>';
  };
  const promptLine = (svg) => (svg ? `<div class="ft-vp">${escapeHtml(svg)}</div>` : '');
  const version = (cls, label, svg, image, caption) => `
    <div class="ft-v ${cls}">
      <div class="ft-vh">${label}</div>
      ${thumb(svg, image)}
      ${caption ? `<div class="ft-vc">${escapeHtml(caption)}</div>` : ''}
      ${promptLine(svg)}
    </div>`;

  dbg.innerHTML = panels.map((p) => {
    const note = p.note || p.pastNote;
    const kb = p.image ? Math.round((p.image.length * 0.75) / 1024) : 0;
    const rej = (p.artHistory || [])[0];           // the version the Critic sent back
    const compare = rej
      ? `<div class="ft-versions">
           ${version('rejected', '✕ Rejected', rej.svg, rej.image, p.rejectedCaption)}
           ${version('approved', '✓ Approved', p.svg, p.image, p.caption)}
         </div>`
      : '';
    return `<div class="ft-panel">
      <div class="ft-h">Panel ${String(p.n).padStart(2, '0')} · ${escapeHtml(p.status || '')}${rej ? ' · revised' : ''}</div>
      ${note ? `<div class="ft-row ft-note"><b>critic</b>${escapeHtml(note.text)}</div>` : ''}
      ${compare || `
        <div class="ft-row ft-cap"><b>caption</b>${escapeHtml(p.caption)}</div>
        ${p.svg ? `<div class="ft-row"><b>image prompt</b>${escapeHtml(p.svg)}</div>` : ''}
        <div class="ft-row"><b>image</b>${p.image ? `rendered · ~${kb} KB` : '— (placeholder)'}</div>`}
    </div>`;
  }).join('');
}

function renderAll() {
  renderBrief(); renderCrew(); renderProgress(); renderLog(); renderFullText();
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

function startRun() {
  stopRun();
  state = freshState();

  const idea = ($('idea').value || '').trim() || 'A sleepy bear tries to stay awake to see the first snow.';
  const style = $('style').value;
  const total = parseInt($('count').value, 10) || 5;
  state.brief = { idea, style, total };
  state.running = true;

  // reset the view
  $('gallery').innerHTML = '<div class="empty" id="gallery-empty">'
    + 'Contacting the JiuwenSwarm crew over A2A… first panels take ~20–40s while the story is written.</div>';
  renderAll();
  $('crew-live').textContent = 'live';

  setInputsDisabled(true);
  // stopRun() (above) already called narrateStop() — just reset this button's own label/state.
  const readBtn = $('read-story');
  readBtn.disabled = true; readBtn.textContent = '🔊 Read story aloud'; readBtn.classList.remove('reading');
  $('download').disabled = true;
  $('download-gif').disabled = true;
  $('download-pdf').disabled = true;
  $('restyle').disabled = true;
  $('restyle-style').disabled = true;
  $('restyle-style-preset').disabled = true;
  const go = $('go');
  go.textContent = 'Running…'; go.classList.add('running'); go.classList.remove('again'); go.disabled = true;

  source = new A2AEventSource(state.brief, { onFatal: abortRun });
  source.start(apply);
}

// The live bridge/swarm is unreachable or dropped before producing anything usable — surface
// it and reset to idle rather than pretending the run finished.
function abortRun(msg) {
  stopRun();
  state.running = false; state.done = false;
  renderProgress();
  $('crew-live').textContent = 'idle';
  const go = $('go');
  go.textContent = 'Go'; go.classList.remove('running'); go.classList.remove('again'); go.disabled = false;
  setInputsDisabled(false);
  showLiveNote(msg);
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
  // Flip running BEFORE re-rendering panels: panelInnerHtml's canRegen check reads
  // state.running, so every panel's card needs a repaint under the new value to pick up
  // the "↻ Redo image" button — not just the ones this loop settles below.
  state.running = false; state.done = true;
  // A run can end (backend completion, or a dropped connection) while a panel is still
  // mid-render: it has an image prompt but no image and no error yet. Saying "Story
  // complete" while that panel is stuck on "rendering…" forever would be a lie — settle
  // it explicitly so the UI matches reality.
  //
  // Separately: the crew's own terminal events (panel.status:"approved", an agent's final
  // status:"done") are sometimes dropped from a run's protocol — a documented
  // non-determinism (see README "What's real vs approximate"), not something this bridge
  // can fully guarantee. Once the run is genuinely done, any panel/agent still showing a
  // mid-run status (a "Drafting" pill, an agent stuck on "revising") is stale, not real —
  // reconcile it the same way the image-stragglers above are reconciled.
  for (const p of state.panels) {
    if (!p.image && !p.imageError && p.svg) {
      p.imageError = 'run ended before this panel finished rendering';
    }
    if (p.status !== 'approved') {
      p.status = 'approved';
      if (p.note) p.pastNote = p.note;
      p.note = null;
    }
    renderPanel(p.n);
  }
  for (const id of AGENT_ORDER) {
    const a = state.agents[id];
    if (a.status === 'reject') continue;   // preserve a genuine error indicator
    // Unconditional, even if status already reads "done": a model's settle event has been
    // seen carrying a stray leftover `state` (e.g. "revising") alongside status:"done" even
    // though the brief tells it to omit `state` on settle events. The UI prefers `state`
    // over `status` for its display word (see renderCrew), so a leftover `state` field
    // alone — independent of `status` — is enough to leave an agent looking stuck.
    a.status = 'done';
    delete a.state;
  }
  renderCrew();
  renderProgress();
  $('crew-live').textContent = 'done';
  const go = $('go');
  go.textContent = 'Run again'; go.classList.remove('running'); go.classList.add('again'); go.disabled = false;
  setInputsDisabled(false);
  const hasStory = state.panels.filter((p) => p.caption).length > 0;
  $('read-story').disabled = !hasStory || !SPEECH_SUPPORTED;
  $('download').disabled = !hasStory;
  $('download-gif').disabled = !hasStory;
  $('download-pdf').disabled = !hasStory;
  $('restyle').disabled = !hasStory;
  $('restyle-style').disabled = !hasStory;
  $('restyle-style-preset').disabled = !hasStory;
}

function stopRun() {
  if (source) { source.stop(); source = null; }
  Object.keys(typers).forEach(cancelTyper);
  narrateStop();   // a fresh run (or an abort) shouldn't keep reading a previous/abandoned one
}

function setInputsDisabled(disabled) {
  ['idea', 'style', 'style-preset', 'count', 'surprise'].forEach((id) => { $(id).disabled = disabled; });
}

/* ------------------------------- style preset --------------------------------- */
// A preset <select> next to a free-text style <input>: picking a preset fills the text
// field, which stays the actual source of truth and is always directly editable. Resetting
// the select back to its placeholder after each pick means it reads as a picker, not a
// second copy of the current value, and re-picking the same preset later still fires 'change'.
function wireStylePreset(selectId, inputId) {
  const select = $(selectId);
  const input = $(inputId);
  select.addEventListener('change', () => {
    if (!select.value) return;
    input.value = select.value;
    select.value = '';
  });
}

/* ---------------------------------- helpers --------------------------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* --------------------------- download story (export) ------------------------ */
// Self-contained HTML "flip book": rendered as a two-page open book spread where pages
// turn cleanly around a central book spine.
function buildStoryHtml() {
  const b = state.brief;
  const panels = state.panels.filter((p) => p.caption);

  const coverPage = `
    <div class="page-inner cover">
      <div class="eyebrow">Inkwell Studio</div>
      <p class="idea">“${escapeHtml(b.idea)}”</p>
      <p class="hint">turn the page to begin →</p>
    </div>`;

  const panelPages = panels.map((p) => {
    const art = p.image ? `<img src="${p.image}" alt="">` : `<div class="ph">“${escapeHtml(p.svg || '')}”</div>`;
    return `
    <div class="page-inner panel">
      <div class="art">${art}</div>
      <p class="cap">${escapeHtml(p.caption)}</p>
    </div>`;
  });

  const closingPage = `
    <div class="page-inner cover closing">
      <div class="eyebrow">The End</div>
      <p class="meta">An illustrated story, made by a crew of agents<br>powered by JiuwenSwarm over A2A</p>
    </div>`;

  const pages = [coverPage, ...panelPages, closingPage];
  const pageHtml = pages.map((inner, i) => `<div class="page" data-i="${i}">${inner}</div>`).join('\n');
  const dotsHtml = pages.map((_, i) => `<button class="dot" data-i="${i}" aria-label="Go to page ${i + 1}"></button>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(b.idea)} — Inkwell Studio</title>
<style>
  :root{color-scheme:light}
  * { box-sizing: border-box; }
  body{margin:0;
       background:radial-gradient(1200px 620px at 82% -10%, #f4eddc 0%, rgba(244,237,220,0) 55%), #e9dfc8;
       color:#241f18;font-family:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;
       min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px}
  h1{position:fixed;top:18px;left:22px;margin:0;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#8c2f2a;
     font-family:ui-monospace,"Cascadia Code","SF Mono",Menlo,Consolas,monospace}
  
  /* Book spread stage */
  .stage{position:relative;width:min(900px,94vw);aspect-ratio:8/5}
  
  /* Underlying paper base for left side of the open book */
  .book-base-left {
    position:absolute; top:0; left:0; width:50%; height:100%;
    background:#efe8da; border:1px solid #c3b490; border-radius:4px 0 0 4px;
    box-shadow:-10px 18px 40px rgba(60,45,20,.15);
  }
  
  /* Central book spine visual guide */
  .stage::after {
    content:''; position:absolute; top:0; bottom:0; left:50%; width:2px;
    background:linear-gradient(90deg, rgba(0,0,0,0.15), rgba(0,0,0,0.05), rgba(0,0,0,0.15));
    z-index:9990; transform:translateX(-50%);
  }

  .pages{position:absolute;inset:0;perspective:2200px}
  
  /* Page takes up the right half and turns along its left edge (spine) */
  .page{position:absolute;top:0;right:0;width:50%;height:100%;
        transform-origin:left center;
        backface-visibility:hidden;transform-style:preserve-3d;
        transition:transform .7s cubic-bezier(.4,.1,.2,1);
        border:1px solid #c3b490;border-radius:0 4px 4px 0;overflow:hidden;background:#f6f0e2;
        box-shadow:0 18px 50px rgba(60,45,20,.25)}
        
  .page-inner{position:absolute;inset:0;display:flex;flex-direction:column}
  .page .art{flex:0 0 62%;position:relative;overflow:hidden;background:#f0e8d5}
  .page .art img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
  .page .ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;
      font-family:Georgia,serif;font-style:italic;color:#6a6051;background:linear-gradient(180deg,#f0e8d5,#e9dfc8)}
  .page .cap{font-size:16px;line-height:1.55;padding:18px 20px 20px;margin:0;flex:1 1 auto;overflow:auto;color:#241f18}
  .cover{align-items:center;justify-content:center;text-align:center;padding:40px;gap:14px;
         background:linear-gradient(180deg,#f6f0e2,#efe6d0)}
  .cover .eyebrow{font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:#8c2f2a;
      font-family:ui-monospace,"Cascadia Code","SF Mono",Menlo,Consolas,monospace}
  .cover .idea{font-family:Georgia,serif;font-style:italic;font-size:26px;margin:0;max-width:38ch;color:#241f18}
  .cover .meta{color:#6a6051;font-family:ui-monospace,"Cascadia Code","SF Mono",Menlo,Consolas,monospace;font-size:12px;letter-spacing:.04em;line-height:1.7}
  .cover .hint{color:#9a8e76;font-size:12px;margin-top:6px}
  .closing .eyebrow{color:#9c3327}
  .nav{position:absolute;top:50%;translate:0 -50%;width:44px;height:44px;border-radius:50%;border:1px solid #c3b490;
       background:rgba(246,240,226,.92);color:#241f18;font-size:16px;cursor:pointer;z-index:9999}
  .nav:disabled{opacity:.35;cursor:default}
  .nav:hover:not(:disabled){background:#8c2f2a;color:#f6f0e2;border-color:#8c2f2a}
  .nav.prev{left:-58px}
  .nav.next{right:-58px}
  @media (max-width:640px){ .nav.prev{left:6px} .nav.next{right:6px} }
  .clickzone{position:absolute;top:0;bottom:0;width:35%;z-index:9998;cursor:pointer}
  .clickzone.left{left:0} .clickzone.right{right:0}
  .chrome{display:flex;flex-direction:column;align-items:center;gap:10px}
  .pageno{font-family:ui-monospace,"Cascadia Code","SF Mono",Menlo,Consolas,monospace;font-size:12px;color:#6a6051;letter-spacing:.04em}
  .dots{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;max-width:80vw}
  .dot{width:7px;height:7px;border-radius:50%;border:0;background:#d5c9ac;cursor:pointer;padding:0}
  .dot.active{background:#8c2f2a}
  @media (prefers-reduced-motion: reduce){ .page{ transition:none } }
</style></head><body>
<h1>Inkwell Studio</h1>
<div class="stage" id="stage">
  <div class="book-base-left"></div>
  <div class="pages" id="pages">${pageHtml}</div>
  <button class="nav prev" id="prev" aria-label="Previous page">‹</button>
  <button class="nav next" id="next" aria-label="Next page">›</button>
  <div class="clickzone left" id="zoneLeft"></div>
  <div class="clickzone right" id="zoneRight"></div>
</div>
<div class="chrome">
  <div class="pageno" id="pageno"></div>
  <div class="dots" id="dots">${dotsHtml}</div>
</div>
<script>
(function () {
  var pages = Array.prototype.slice.call(document.querySelectorAll('.page'));
  var total = pages.length;
  var current = 0, animating = false, DURATION = 700;
  var prevBtn = document.getElementById('prev');
  var nextBtn = document.getElementById('next');
  var pageno = document.getElementById('pageno');
  var dots = Array.prototype.slice.call(document.querySelectorAll('.dot'));

  function layout() {
    pages.forEach(function (el, i) {
      if (i === current) { 
        el.style.transform = 'rotateY(0deg)'; 
        el.style.zIndex = total; 
      }
      else if (i < current) { 
        el.style.transform = 'rotateY(-180deg)'; 
        el.style.zIndex = i; 
      }
      else { 
        el.style.transform = 'rotateY(0deg)'; 
        el.style.zIndex = total - (i - current); 
      }
    });
    pageno.textContent = (current + 1) + ' / ' + total;
    prevBtn.disabled = current === 0;
    nextBtn.disabled = current === total - 1;
    dots.forEach(function (d, i) { d.classList.toggle('active', i === current); });
  }

  function turn(to) {
    if (animating || to === current || to < 0 || to > total - 1) return;
    animating = true;
    var dir = to > current ? 1 : -1;
    var mover = pages[dir > 0 ? current : to];
    mover.style.zIndex = total + 1;
    void mover.offsetWidth; // force reflow
    mover.style.transform = dir > 0 ? 'rotateY(-180deg)' : 'rotateY(0deg)';
    current = to;
    pageno.textContent = (current + 1) + ' / ' + total;
    prevBtn.disabled = current === 0;
    nextBtn.disabled = current === total - 1;
    dots.forEach(function (d, i) { d.classList.toggle('active', i === current); });
    setTimeout(function () { layout(); animating = false; }, DURATION);
  }

  prevBtn.addEventListener('click', function () { turn(current - 1); });
  nextBtn.addEventListener('click', function () { turn(current + 1); });
  document.getElementById('zoneLeft').addEventListener('click', function () { turn(current - 1); });
  document.getElementById('zoneRight').addEventListener('click', function () { turn(current + 1); });
  dots.forEach(function (d, i) { d.addEventListener('click', function () { turn(i); }); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') turn(current + 1);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') turn(current - 1);
  });

  layout();
})();
</script>
</body></html>`;
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
// Rasterize a panel's art (the rendered image, or the prompt placeholder) to a PNG data
// URI via canvas, so the bridge (Pillow) can assemble the GIF/PDF.
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
    if (p.image) {
      const img = new Image();
      img.onload = () => draw((ctx) => ctx.drawImage(img, 0, 0, W, Hh));
      img.onerror = () => resolve(null);
      img.src = p.image;
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

/* --------------------------- download PDF (printable) ------------------------ */
// Same title-card + one-page-per-panel composition as the GIF (server/pdfexport.py reuses
// server/gifexport.py's frame builders), just paginated instead of animated — a printable
// keepsake of the finished story.
async function downloadPdf() {
  const btn = $('download-pdf');
  if (btn.disabled) return;
  const label = btn.textContent;
  btn.classList.add('busy'); btn.textContent = '⟳ Rendering PDF…'; btn.disabled = true;
  try {
    const panels = state.panels.filter((p) => p.caption);
    const out = [];
    for (const p of panels) {                      // rasterize sequentially (concurrent
      out.push({ n: p.n, caption: p.caption, png: await panelArtToPng(p) });  // loads can race)
    }
    const payload = { idea: state.brief.idea, style: state.brief.style, panels: out };
    const res = await fetch('/export/pdf', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`bridge ${res.status}`);
    triggerDownload(await res.blob(), `inkwell-${storySlug()}.pdf`);
  } catch (e) {
    showLiveNote(`Couldn't build the PDF (${e.message}). PDF export needs the bridge running.`);
  } finally {
    btn.classList.remove('busy'); btn.textContent = label; btn.disabled = false;
  }
}

/* ------------------------------- restyle images ------------------------------ */
// Re-render every panel's picture in a new style, WITHOUT touching text: same captions,
// same image prompts, just a fresh /restyle call per panel with the new style. Each restyle
// gets a genuinely fresh seed server-side (no seed reuse) — with a low-step distilled model
// the seed can dominate the output enough that reusing it silently produces no visible
// change. See server/bridge.py's /restyle for the backend side.
async function restyleStory() {
  const btn = $('restyle');
  if (btn.disabled) return;
  const newStyle = ($('restyle-style').value || '').trim();
  const panels = state.panels.filter((p) => p.caption && p.svg);
  if (!newStyle || !panels.length) return;

  const label = btn.textContent;
  btn.classList.add('busy'); btn.textContent = '⟳ Restyling…'; btn.disabled = true;
  try {
    const payload = {
      style: newStyle,
      panels: panels.map((p) => ({ n: p.n, prompt: p.svg })),
    };
    const res = await fetch('/restyle', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`bridge ${res.status}`);
    const { panels: results } = await res.json();
    let failed = 0;
    for (const r of results || []) {
      const p = state.panels.find((x) => x.n === r.n);
      if (!p) continue;
      if (r.src) { p.image = r.src; p.imageError = null; }
      else failed += 1;
      renderPanel(p.n);
    }
    state.brief.style = newStyle;
    renderBrief();
    if (failed) showLiveNote(`${failed} panel${failed > 1 ? 's' : ''} couldn't be restyled — kept the previous image.`);
  } catch (e) {
    showLiveNote(`Couldn't restyle (${e.message}). Restyle needs the bridge running.`);
  } finally {
    btn.classList.remove('busy'); btn.textContent = label; btn.disabled = false;
  }
}

/* ------------------------------- read story aloud ------------------------------ */
// On-demand replay of a FINISHED story through the same narration engine as the live
// narration (above), but deliberately bypasses the narrationOn gate — clicking this
// button IS the explicit ask, regardless of whether SpeechSynthesis is otherwise
// unavailable/unsupported. Click again while reading to stop early.
function readStoryAloud() {
  const btn = $('read-story');
  if (!SPEECH_SUPPORTED || btn.disabled) return;
  if (narrating || narrateQueue.length) {
    narrateStop();
    btn.textContent = '🔊 Read story aloud';
    btn.classList.remove('reading');
    return;
  }
  const panels = state.panels.filter((p) => p.caption).sort((a, b) => a.n - b.n);
  if (!panels.length) return;
  panels.forEach((p) => narrateQueue.push(p.caption));
  btn.textContent = '⏹ Stop reading';
  btn.classList.add('reading');
  narrateOnIdle = () => { btn.textContent = '🔊 Read story aloud'; btn.classList.remove('reading'); };
  narratePump();
}

/* --------------------------- regenerate one panel ----------------------------- */
// Redo a single panel's picture — same caption, same image prompt, just a fresh /panel/
// regenerate call with a new render — without touching any other panel or re-running the
// crew. The single-panel sibling of restyleStory() above (see server/bridge.py's
// /panel/regenerate). Like restyle, never reuses a seed, so the result is guaranteed to
// actually look different from what's on screen.
async function regeneratePanel(n) {
  const p = state.panels.find((x) => x.n === n);
  if (!p || !p.svg || state.running || p.regenerating) return;
  p.regenerating = true;
  renderPanel(n);
  try {
    const res = await fetch('/panel/regenerate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ n, prompt: p.svg, style: state.brief.style }),
    });
    if (!res.ok) throw new Error(`bridge ${res.status}`);
    const { src, error } = await res.json();
    if (src) {
      p.image = src; p.imageError = null;
    } else {
      if (!p.image) p.imageError = error || 'render failed';   // keep a picture we already have
      showLiveNote(`Couldn't redo panel ${n}'s image${error ? ` (${error})` : ''}`
        + `${p.image ? ' — kept the previous picture.' : '.'}`);
    }
  } catch (e) {
    showLiveNote(`Couldn't redo panel ${n}'s image (${e.message}). Needs the bridge running.`);
  } finally {
    p.regenerating = false;
    renderPanel(n);
  }
}

/* ----------------------------------- boot ----------------------------------- */

$('promptbar').addEventListener('submit', (e) => {
  e.preventDefault();
  if (state.running) return;
  startRun();
});

$('surprise').addEventListener('click', surpriseIdea);
wireStylePreset('style-preset', 'style');
wireStylePreset('restyle-style-preset', 'restyle-style');
$('download').addEventListener('click', () => { if (!$('download').disabled) downloadStory(); });
$('download-gif').addEventListener('click', downloadGif);
$('download-pdf').addEventListener('click', downloadPdf);
$('restyle').addEventListener('click', restyleStory);
$('gallery').addEventListener('click', (e) => {
  const btn = e.target.closest('.regen-btn');
  if (!btn || btn.disabled) return;
  regeneratePanel(parseInt(btn.dataset.panel, 10));
});

if (!SPEECH_SUPPORTED) {
  $('read-story').disabled = true;
  $('read-story').title = 'This browser does not support speech synthesis.';
} else {
  $('read-story').addEventListener('click', readStoryAloud);
}

const params = new URLSearchParams(location.search);
renderAll();   // show the idle crew / progress on load

// dev/demo aid: open with ?autorun=1 to start a run immediately on load
if (params.has('autorun')) startRun();

// small automation/debug hook (export + state), used by verification tooling
window.__inkwell = {
  buildStoryHtml, downloadStory, downloadGif, downloadPdf, panelArtToPng,
  getState: () => state,
};
