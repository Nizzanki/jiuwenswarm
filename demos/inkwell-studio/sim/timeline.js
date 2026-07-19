// Inkwell Studio — Phase 1 simulated run.
//
// buildTimeline(brief) returns an ordered list of { at, event } where `at` is an
// absolute millisecond offset from the start of the run. app.js schedules each event
// with setTimeout(at) and feeds it through the same reducer a real A2A stream would.
//
// Everything here is CANNED: the SVG "art" and the captions are fixed to one story
// (the lighthouse keeper). The typed idea/style are only echoed into the brief header
// so the run feels responsive. Phase 2 replaces this file's source with a real swarm.

/* ----------------------------- canned panel art ----------------------------- */
// viewBox 0 0 320 200, painterly-storybook palette. Panels 1–3 draft match the mockup.

const SVG = {
  p1: `<svg viewBox="0 0 320 200" role="img" aria-label="A lighthouse on a cliff at dusk, its beam sweeping over a calm sea.">
    <defs>
      <linearGradient id="dusk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2a45c"/><stop offset="0.45" stop-color="#c76a6a"/><stop offset="1" stop-color="#3a3a63"/></linearGradient>
      <linearGradient id="sea1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a4d78"/><stop offset="1" stop-color="#1c2544"/></linearGradient>
      <linearGradient id="beam1" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff2c4" stop-opacity="0.85"/><stop offset="1" stop-color="#fff2c4" stop-opacity="0"/></linearGradient>
    </defs>
    <rect width="320" height="200" fill="url(#dusk)"/>
    <circle cx="70" cy="70" r="26" fill="#ffe6a8" opacity="0.9"/>
    <rect y="128" width="320" height="72" fill="url(#sea1)"/>
    <path d="M0,128 h320 M0,140 h320 M0,152 h320" stroke="#5570a0" stroke-width="1" opacity="0.3"/>
    <path d="M190,200 L200,110 L232,110 L242,200 Z" fill="#20263c"/>
    <rect x="196" y="120" width="40" height="10" fill="#b8443f"/><rect x="196" y="150" width="40" height="9" fill="#b8443f"/>
    <rect x="203" y="92" width="26" height="20" fill="#2b3350"/><rect x="207" y="96" width="18" height="12" fill="#ffe08a"/>
    <polygon points="223,102 320,70 320,134" fill="url(#beam1)"/>
    <path d="M170,200 Q186,150 200,200 Z" fill="#161b2c"/>
  </svg>`,

  p2: `<svg viewBox="0 0 320 200" role="img" aria-label="A vast dark shape with a single glowing eye rising from a moonlit sea.">
    <defs>
      <linearGradient id="night2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0e1730"/><stop offset="1" stop-color="#060a18"/></linearGradient>
      <radialGradient id="eye2" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffe9a8"/><stop offset="0.5" stop-color="#e0973f" stop-opacity="0.8"/><stop offset="1" stop-color="#e0973f" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="320" height="200" fill="url(#night2)"/>
    <circle cx="250" cy="52" r="24" fill="#e9edf5" opacity="0.85"/>
    <rect y="120" width="320" height="80" fill="#0a1226"/>
    <path d="M0,120 h320 M0,134 h320 M0,150 h320" stroke="#2c3a63" stroke-width="1" opacity="0.4"/>
    <path d="M40,200 Q150,70 280,200 Z" fill="#0c1220"/>
    <path d="M60,200 Q150,96 250,200 Z" fill="#0f1626"/>
    <circle cx="150" cy="126" r="20" fill="url(#eye2)"/>
    <circle cx="150" cy="126" r="7" fill="#fff2c4"/><circle cx="150" cy="126" r="3" fill="#1b1206"/>
    <polygon points="8,120 40,108 8,132" fill="#fff2c4" opacity="0.25"/>
  </svg>`,

  // panel 3 — the rejected draft: cold, the creature reads menacing (matches mockup)
  p3draft: `<svg viewBox="0 0 320 200" role="img" aria-label="Draft: the keeper on the rocks holding a lantern toward a large, looming creature.">
    <defs><linearGradient id="night3" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#141d38"/><stop offset="1" stop-color="#0a1020"/></linearGradient></defs>
    <rect width="320" height="200" fill="url(#night3)"/>
    <rect y="150" width="320" height="50" fill="#0a1020"/>
    <path d="M120,200 Q220,70 320,150 L320,200 Z" fill="#161d30"/>
    <circle cx="235" cy="120" r="11" fill="#c74b4b"/><circle cx="238" cy="118" r="4" fill="#ffcaa0"/>
    <path d="M40,200 L40,168 Q52,150 64,168 L64,200 Z" fill="#1a2136"/>
    <circle cx="52" cy="150" r="6" fill="#242c44"/>
    <circle cx="78" cy="170" r="7" fill="#ffd67a"/><circle cx="78" cy="170" r="2.5" fill="#fff6df"/>
  </svg>`,

  // panel 3 — the warmer revision: gentle meeting, lantern glow between them
  p3warm: `<svg viewBox="0 0 320 200" role="img" aria-label="A gentle meeting: the keeper sets a warm lantern between himself and a soft, curious sea creature.">
    <defs>
      <linearGradient id="warm3" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a3358"/><stop offset="0.6" stop-color="#3d3a55"/><stop offset="1" stop-color="#141428"/></linearGradient>
      <radialGradient id="glow3" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffe6a8" stop-opacity="0.95"/><stop offset="0.5" stop-color="#e0973f" stop-opacity="0.45"/><stop offset="1" stop-color="#e0973f" stop-opacity="0"/></radialGradient>
      <radialGradient id="soft-eye" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff2c4"/><stop offset="1" stop-color="#82b98d" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="320" height="200" fill="url(#warm3)"/>
    <circle cx="60" cy="52" r="20" fill="#ffe6a8" opacity="0.5"/>
    <rect y="150" width="320" height="50" fill="#141428"/>
    <path d="M150,200 Q235,120 320,168 L320,200 Z" fill="#28324f"/>
    <path d="M175,200 Q235,150 300,182 L300,200 Z" fill="#33406a"/>
    <circle cx="250" cy="150" r="34" fill="#3b4a72"/>
    <circle cx="238" cy="146" r="10" fill="url(#soft-eye)"/><circle cx="238" cy="146" r="3.5" fill="#20301f"/>
    <ellipse cx="160" cy="176" rx="60" ry="30" fill="url(#glow3)"/>
    <path d="M60,200 L60,172 Q70,156 80,172 L80,200 Z" fill="#2a2438"/>
    <circle cx="70" cy="156" r="6" fill="#3a3350"/>
    <circle cx="150" cy="176" r="9" fill="#ffd67a"/><circle cx="150" cy="176" r="3" fill="#fff6df"/>
  </svg>`,

  p4: `<svg viewBox="0 0 320 200" role="img" aria-label="Keeper and sea creature side by side beneath the turning lighthouse beam, sharing one light.">
    <defs>
      <linearGradient id="night4" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#20284d"/><stop offset="1" stop-color="#0b1020"/></linearGradient>
      <linearGradient id="beam4" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff2c4" stop-opacity="0.7"/><stop offset="1" stop-color="#fff2c4" stop-opacity="0"/></linearGradient>
    </defs>
    <rect width="320" height="200" fill="url(#night4)"/>
    <g opacity="0.85"><circle cx="40" cy="40" r="1.5" fill="#dfe6f5"/><circle cx="90" cy="26" r="1.2" fill="#dfe6f5"/><circle cx="150" cy="44" r="1.4" fill="#dfe6f5"/><circle cx="210" cy="30" r="1.2" fill="#dfe6f5"/><circle cx="285" cy="48" r="1.5" fill="#dfe6f5"/></g>
    <polygon points="150,0 90,150 210,150" fill="url(#beam4)"/>
    <rect y="150" width="320" height="50" fill="#0a1022"/>
    <path d="M0,150 h320 M0,164 h320" stroke="#2c3a63" stroke-width="1" opacity="0.4"/>
    <path d="M120,200 Q150,120 180,200 Z" fill="#141a30"/>
    <circle cx="235" cy="150" r="30" fill="#2b3a5c"/><circle cx="224" cy="146" r="6" fill="#82b98d"/>
    <path d="M96,200 L96,172 Q106,158 116,172 L116,200 Z" fill="#1c2338"/><circle cx="106" cy="158" r="6" fill="#2a3450"/>
    <circle cx="150" cy="178" r="8" fill="#ffd67a"/><circle cx="150" cy="178" r="2.6" fill="#fff6df"/>
  </svg>`,

  p5: `<svg viewBox="0 0 320 200" role="img" aria-label="Dawn: the lighthouse beam sweeps over calm water where the creature waits, the sea giving something back.">
    <defs>
      <linearGradient id="dawn5" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6c98a"/><stop offset="0.5" stop-color="#e79a7c"/><stop offset="1" stop-color="#5b6aa0"/></linearGradient>
      <linearGradient id="sea5" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6f86b8"/><stop offset="1" stop-color="#2c3a68"/></linearGradient>
      <linearGradient id="beam5" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff4d0" stop-opacity="0.8"/><stop offset="1" stop-color="#fff4d0" stop-opacity="0"/></linearGradient>
    </defs>
    <rect width="320" height="200" fill="url(#dawn5)"/>
    <circle cx="255" cy="60" r="30" fill="#fff0cf" opacity="0.9"/>
    <rect y="132" width="320" height="68" fill="url(#sea5)"/>
    <path d="M0,132 h320 M0,146 h320 M0,160 h320" stroke="#a9bde0" stroke-width="1" opacity="0.35"/>
    <path d="M70,200 L80,118 L108,118 L118,200 Z" fill="#26304c"/>
    <rect x="76" y="126" width="36" height="9" fill="#c15a4f"/>
    <rect x="82" y="100" width="24" height="18" fill="#2f3a58"/><rect x="86" y="104" width="16" height="11" fill="#ffe08a"/>
    <polygon points="100,110 30,150 100,170" fill="url(#beam5)"/>
    <circle cx="228" cy="150" r="26" fill="#3f5687"/><circle cx="218" cy="146" r="6" fill="#82b98d"/>
    <path d="M200,150 q28,-14 52,2" stroke="#cbe0ff" stroke-width="2" fill="none" opacity="0.5"/>
  </svg>`,
};

/* ------------------------------ canned captions ----------------------------- */

const CAP = {
  p1: 'For thirty years, Elias kept the lamp alone. The sea gave him nothing but weather.',
  p2: 'Then one storm-black night, something vast and patient rose to watch his light.',
  p3draft: 'Elias set out a lantern, and the creature drew near.',
  p3warm: 'He set the lantern down between them. The great eye softened, and did not look away.',
  p4: 'Night after night they met — a keeper, a leviathan, and one small shared light.',
  p5: 'Now the beam sweeps for two. The sea, at last, gives something back.',
};

const AGENT_LABELS = { imageGen: 'tool' };

/* ------------------------------- the timeline ------------------------------- */

export function buildTimeline(brief) {
  const seq = [];
  let clock = 0;
  const push = (gap, event) => { clock += gap; seq.push({ at: clock, event }); };

  const total = brief.total || 5;

  // 0 — echo the brief the author actually typed
  push(0, { t: 'brief', idea: brief.idea, style: brief.style, total });
  push(150, { t: 'progress', approved: 0, inReview: 0, drafting: 0, total });

  // seed the crew as idle/queued
  push(150, { t: 'agent', id: 'writer',      status: 'idle', say: 'Ready to draft the opening beat.' });
  push(0,   { t: 'agent', id: 'artDirector', status: 'idle', say: 'Waiting for the first beat.' });
  push(0,   { t: 'agent', id: 'imageGen',    status: 'idle', say: 'No panels rendered yet.' });
  push(0,   { t: 'agent', id: 'editor',      status: 'idle', say: 'Watching the flow.' });
  push(0,   { t: 'agent', id: 'critic',      status: 'idle', say: 'Standing by to review.' });

  // ---- helper: a straightforward "happy path" panel ----
  function happyPanel(n, svg, caption, { draft = 1300, prompt = 900, render = 1100, review = 1100, approve = 900 } = {}) {
    push(500, { t: 'panel.status', panel: n, status: 'drafting' });
    push(0,   { t: 'agent', id: 'writer', status: 'active', say: `Drafting the panel ${n} beat…` });
    push(0,   { t: 'progress', approved: approvedSoFar, inReview: 0, drafting: 1, total });

    push(draft,  { t: 'agent', id: 'writer', status: 'done', say: `Panel ${n} beat handed off.` });
    push(0,      { t: 'panel.status', panel: n, status: 'rendering' });
    push(0,      { t: 'agent', id: 'artDirector', status: 'active', say: `Turning beat ${n} into an image prompt…` });

    push(prompt, { t: 'agent', id: 'artDirector', status: 'done', say: `Prompt for panel ${n} ready.` });
    push(0,      { t: 'agent', id: 'imageGen', status: 'active', say: `Rendering panel ${n}…` });

    push(render, { t: 'panel.art', panel: n, svg });
    push(0,      { t: 'panel.status', panel: n, status: 'review' });
    push(0,      { t: 'agent', id: 'imageGen', status: 'done', say: `Panel ${n} rendered.` });
    push(0,      { t: 'agent', id: 'critic', status: 'active', say: `Reviewing panel ${n} against the brief…` });
    push(0,      { t: 'progress', approved: approvedSoFar, inReview: 1, drafting: 0, total });

    push(200,    { t: 'panel.caption', panel: n, text: caption, dim: false });

    push(review, { t: 'panel.status', panel: n, status: 'approved' });
    push(0,      { t: 'agent', id: 'critic', status: 'done', say: `Panel ${n} approved — on brief.` });
    approvedSoFar += 1;
    push(0,      { t: 'progress', approved: approvedSoFar, inReview: 0, drafting: 0, total });
    push(approve, null); // small breath before next panel (null events are skipped)
  }

  let approvedSoFar = 0;

  // ---- Panel 1 & 2: happy path ----
  happyPanel(1, SVG.p1, CAP.p1);
  happyPanel(2, SVG.p2, CAP.p2);

  // ---- Panel 3: the money moment — draft, render, REJECT, revise, approve ----
  const n = 3;
  push(500, { t: 'panel.status', panel: n, status: 'drafting' });
  push(0,   { t: 'agent', id: 'writer', status: 'active', say: 'Drafting the panel 3 beat…' });
  push(0,   { t: 'progress', approved: approvedSoFar, inReview: 0, drafting: 1, total });
  push(0,   { t: 'focus', panel: 3 });
  push(0,   { t: 'log', panel: 3, step: 1, html: '<b>Writer</b> drafted the panel-3 beat.' });

  push(1300, { t: 'agent', id: 'writer', status: 'done', say: 'Panel 3 beat handed off.' });
  push(0,    { t: 'panel.status', panel: n, status: 'rendering' });
  push(0,    { t: 'agent', id: 'artDirector', status: 'active', say: 'Prompting the image for panel 3…' });
  push(900,  { t: 'log', panel: 3, step: 2, html: '<b>Art Director</b> prompted the image.' });
  push(0,    { t: 'agent', id: 'artDirector', status: 'done', say: 'Prompt for panel 3 ready.' });
  push(0,    { t: 'agent', id: 'imageGen', status: 'active', say: 'Rendering panel 3…' });

  push(1100, { t: 'panel.art', panel: n, svg: SVG.p3draft });
  push(0,    { t: 'panel.status', panel: n, status: 'review' });
  push(0,    { t: 'panel.caption', panel: n, text: CAP.p3draft, dim: true });
  push(0,    { t: 'agent', id: 'imageGen', status: 'done', say: '2 panels rendered · panel 3 draft up.' });
  push(0,    { t: 'agent', id: 'critic', status: 'active', say: 'Reviewing panel 3 against the brief…' });
  push(0,    { t: 'progress', approved: approvedSoFar, inReview: 1, drafting: 0, total });
  push(0,    { t: 'log', panel: 3, step: 3, html: '<b>Image Gen</b> rendered a first draft.' });

  // the rejection — this is the frozen mockup frame
  push(1600, { t: 'panel.status', panel: n, status: 'revising' });
  push(0,    { t: 'panel.note', panel: n, label: 'Critic → sent back', text: 'Reads flat, and the eye looks menacing. Redo warmer — a gentle, hopeful meeting.' });
  push(0,    { t: 'agent', id: 'critic', status: 'reject', say: 'Sent panel 3 back — tone mismatch with the brief.' });
  push(0,    { t: 'agent', id: 'writer', status: 'active', state: 'revising', say: 'Rewriting panel 3 — make the first meeting tender, not tense.' });
  push(0,    { t: 'agent', id: 'artDirector', status: 'idle', state: 'queued', say: 'Waiting on new panel-3 copy to re-prompt the image.' });
  push(0,    { t: 'agent', id: 'imageGen', status: 'idle', say: '2 panels rendered · ready to redraw panel 3.' });
  push(0,    { t: 'log', panel: 3, step: 4, html: '<b>Critic</b> reviewed → <span class="bad">rejected: too menacing</span>.' });
  push(0,    { t: 'log', panel: 3, step: 5, html: '<b>Writer</b> is revising the beat <span class="live">● live</span>' });

  // hold on the frozen frame, then revise → warmer → approve
  push(2600, { t: 'panel.caption', panel: n, text: CAP.p3warm, dim: false });
  push(0,    { t: 'agent', id: 'writer', status: 'done', say: 'Warmer panel-3 copy delivered.' });
  push(0,    { t: 'log', panel: 3, step: 6, html: '<b>Writer</b> delivered warmer copy.' });

  push(900,  { t: 'agent', id: 'artDirector', status: 'active', say: 'Re-prompting panel 3 — warm light, soft creature.' });
  push(0,    { t: 'log', panel: 3, step: 7, html: '<b>Art Director</b> re-prompted the image.' });
  push(900,  { t: 'agent', id: 'artDirector', status: 'done', say: 'New prompt for panel 3 ready.' });
  push(0,    { t: 'agent', id: 'imageGen', status: 'active', say: 'Re-rendering panel 3…' });
  push(1100, { t: 'panel.art', panel: n, svg: SVG.p3warm });
  push(0,    { t: 'agent', id: 'imageGen', status: 'done', say: 'Panel 3 redrawn — warmer.' });
  push(0,    { t: 'log', panel: 3, step: 8, html: '<b>Image Gen</b> re-rendered panel 3.' });
  push(0,    { t: 'agent', id: 'critic', status: 'active', say: 'Re-reviewing panel 3…' });

  push(1300, { t: 'panel.status', panel: n, status: 'approved' });
  push(0,    { t: 'agent', id: 'critic', status: 'done', say: 'Panel 3 approved — that lands.' });
  push(0,    { t: 'log', panel: 3, step: 9, html: '<b>Critic</b> reviewed → <span style="color:var(--green)">approved ✓</span>.' });
  approvedSoFar += 1;
  push(0,    { t: 'progress', approved: approvedSoFar, inReview: 0, drafting: 0, total });
  push(900,  null);

  // ---- Panels 4 & 5: happy path ----
  happyPanel(4, SVG.p4, CAP.p4);
  happyPanel(5, SVG.p5, CAP.p5);

  // ---- Editor's final pass + done ----
  push(400, { t: 'agent', id: 'editor', status: 'active', say: 'Final pass — checking the story flows end to end…' });
  push(1400, { t: 'agent', id: 'editor', status: 'done', say: 'Flow reads clean, panel 1 through 5.' });
  push(0,    { t: 'run.done' });

  return seq.filter((s) => s.event !== null);
}

export { AGENT_LABELS };
