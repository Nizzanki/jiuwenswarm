"""The leader brief for a live Inkwell Studio run.

Phase 2 fidelity is *guided protocol*: a real LLM writes the story, but it is tightly
constrained to (a) act as the fixed 5-role crew, (b) emit ONLY our line-delimited JSON
event protocol, and (c) perform at least one genuine Critic rejection -> Writer revision.

The bridge parses the emitted JSON objects (brace-matched, deduped) into the exact
normalized events the Phase 1 front-end already renders — so the UI is unchanged.

NOTE (honesty): over A2A this runs as a single JiuwenSwarm agent role-playing the crew
(team-mode routing needs a request `mode` param the A2A channel can't set without a
framework source change). The choreography is real LLM work; the crew is one agent.
"""

from __future__ import annotations

# Event shapes mirror sim/timeline.js exactly. Keep this list in sync with the bridge's
# KNOWN_EVENTS and the front-end reducer.
PROTOCOL_SPEC = r"""
You emit a STREAM of events, one compact JSON object per line, and NOTHING else — no
prose, no explanations, no markdown, no ``` fences. Every line MUST be a single valid
JSON object. Allowed events (field names are exact):

{"t":"brief","idea":"<the author's idea>","style":"<the style>","total":<int panels>}
{"t":"agent","id":"<writer|critic|artDirector|imageGen|editor>","status":"<active|done|idle|reject>","say":"<one short present-tense line>","state":"<optional short word e.g. drafting|revising|queued>"}
{"t":"panel.status","panel":<int>,"status":"<drafting|rendering|review|revising|approved>"}
{"t":"panel.art","panel":<int>,"svg":"<a ONE-SENTENCE image prompt describing the picture>"}
{"t":"panel.caption","panel":<int>,"text":"<the story caption for this panel>","dim":<true|false>}
{"t":"panel.note","panel":<int>,"label":"Critic → sent back","text":"<the critic's specific reason>"}
{"t":"log","panel":<int>,"step":<int>,"html":"<short handoff line; may include <b>Name</b> and <span class=\"bad\">rejected: ...</span>>"}
{"t":"progress","approved":<int>,"inReview":<int>,"drafting":<int>,"total":<int>}
{"t":"focus","panel":<int>}
{"t":"run.done"}

Rules:
- CHILD-SAFE, ALWAYS: every caption AND every image prompt (panel.art) must be appropriate
  for young children (roughly ages 4-8) — warm, gentle, wonder-filled. No violence, weapons,
  blood/gore, death, scary or frightening imagery, horror, adult themes, or innuendo. This
  applies to EVERY panel, including the intentionally-flawed panel-3 draft below — reject
  that draft for being flat, rushed, or lacking warmth, never for being graphic or scary.
- Output events in the ORDER they happen, so a viewer watches the story build live.
- The crew has exactly five members with these ids: writer, critic, artDirector, imageGen, editor.
- `panel.art.svg` is a short IMAGE PROMPT sentence (no real image is generated in this phase).
- Emit a `brief` first, then build each panel through its lifecycle:
  drafting -> rendering -> review -> approved, updating the relevant `agent` and `progress`.
- CAPTIONS ARE THE STORY ITSELF. Read end to end, the captions must form ONE continuous
  short story — narrative prose in past tense, each panel picking up exactly where the last
  left off, with a real beginning, middle and end (and a closing line that lands).
  Write the story, NOT a description of the picture: no "we see", no scene-setting inventory
  of objects, no present-tense camera directions. 1-3 sentences per panel, in the author's
  language and the requested style. The image prompt (panel.art) is where visual detail goes.
- EXACTLY ONE panel (choose panel 3 if there are >=3 panels) MUST be genuinely REJECTED by
  the Critic: emit a `focus` on that panel, a `panel.note` with a specific reason, set that
  panel `panel.status:"revising"`, set critic `status:"reject"` and writer `status:"active"`
  (state "revising"), fill the `log` with the numbered handoffs (draft, prompt, render,
  rejected, revising...), THEN actually revise: a new warmer `panel.caption` and `panel.art`,
  and finally `panel.status:"approved"`. This revision loop is the whole point — make it real.
- When all panels are approved, SETTLE the crew: emit `agent` events setting writer, critic,
  artDirector, and imageGen ALL to status "done" (matching the Editor's own final status
  below), so no dots are left active and none read as still pending. Do NOT include a
  `state` field on any of these settle events — the run has finished, so words like
  "queued"/"drafting"/"revising" no longer describe anything and must not linger on screen.
  Then the Editor does a final pass (`agent editor status:"done"`), a final `progress` with
  approved == total, and a single `{"t":"run.done"}`.
- Do NOT wrap the JSON in an array. One object per line. No trailing commentary.
"""


def build_brief(idea: str, style: str, panels: int = 5) -> str:
    idea = (idea or "").strip() or "A sleepy bear tries to stay awake to see the first snow."
    style = (style or "").strip() or "Warm storybook · Painterly"
    panels = max(3, min(int(panels or 5), 6))
    return (
        "You are the director of Inkwell Studio, coordinating a crew of five specialist "
        "agents (Writer, Art Director, Image Generator, Editor, Critic) who together turn "
        "one idea into an illustrated short story, panel by panel.\n\n"
        f"THE AUTHOR'S IDEA: \"{idea}\"\n"
        f"STYLE: {style}\n"
        f"TARGET PANELS: EXACTLY {panels} — not more, not fewer. Number every panel 1..{panels}, "
        "with no gaps and no extra panels beyond that range.\n\n"
        "Produce the story as a LIVE EVENT STREAM using the protocol below. Narrate the "
        "crew's real work: the Writer drafts beats, the Art Director writes image prompts, "
        "the Image Generator renders, the Critic reviews, and on one panel the Critic "
        "genuinely rejects the work and the Writer revises it warmer. The captions must read "
        "as one continuous short story (past tense narrative), not picture descriptions.\n"
        f"{PROTOCOL_SPEC}"
    )


def build_team_brief(idea: str, style: str, panels: int = 3) -> str:
    """Brief for NATIVE team mode. Deliberately LEAN so the real multi-agent team completes
    in bounded time (heavy briefs make the leader poll/coordinate forever and deadlock):
    small crew, few panels, one revision, and the protocol emitted as the FINAL answer."""
    idea = (idea or "").strip() or "A sleepy bear tries to stay awake to see the first snow."
    style = (style or "").strip() or "Warm storybook · Painterly"
    panels = max(2, min(int(panels or 3), 4))
    return (
        "You are the LEADER of a small real agent crew (the jiuwen_team). Delegate genuine work "
        "to teammates to make a short illustrated story — but work FAST and do not over-coordinate.\n\n"
        f"IDEA: \"{idea}\"\nSTYLE: {style}\nPANELS: exactly {panels}\n\n"
        "Do this efficiently:\n"
        f"1. Spawn TWO teammates: a Writer and a Critic.\n"
        f"2. In ONE task, have the Writer write a real short story told across {panels} panels — "
        "the captions, read in order, must be one continuous narrative (past tense, a proper "
        "beginning/middle/end), not descriptions of pictures — plus a one-line image prompt per panel.\n"
        "3. In ONE task, have the Critic review and REJECT exactly one panel as too flat, with a "
        "short reason; the Writer revises just that panel warmer.\n"
        "4. Then STOP delegating and finish.\n"
        "Do not poll repeatedly or spawn more members. Two rounds at most.\n\n"
        "FINAL ANSWER: after the crew finishes, output ONLY our JSON event protocol (one compact "
        "JSON object per line) describing the finished run — the brief, each panel's caption+art+"
        "status, the crew members and their activity, the Critic's rejection note on the revised "
        "panel, the revision-loop log, progress, and a final run.done. No prose, no markdown.\n"
        f"{PROTOCOL_SPEC}"
    )


def build_fill_brief(idea: str, style: str, total: int, prior: list[tuple[int, str]], missing: list[int]) -> str:
    """Patch brief for when the team wrote most of the story but skipped panel(s) `missing`
    (see bridge.py's _incomplete_panels): ask a single agent for ONLY those panels as a
    direct continuation, not the whole story over again. This is deliberately the smallest
    possible ask (no crew role-play, no revision loop, no progress/agent bookkeeping —
    bridge.py synthesizes the status/progress events itself) so the patch is fast; a full
    single-agent re-run is reserved for when the team produced nothing usable to patch."""
    idea = (idea or "").strip() or "A sleepy bear tries to stay awake to see the first snow."
    style = (style or "").strip() or "Warm storybook · Painterly"
    context = "\n".join(f"Panel {n}: {cap}" for n, cap in prior) or "(no earlier panels — write from the idea)"
    panel_list = ", ".join(str(n) for n in missing)
    return (
        "You are completing an illustrated children's story that a crew already started but "
        f"left unfinished. Write ONLY the missing panel(s): {panel_list}. Do not rewrite or "
        "repeat the panels already written below — they are done.\n\n"
        f"THE AUTHOR'S IDEA: \"{idea}\"\nSTYLE: {style}\nTOTAL PANELS IN THE FINISHED STORY: {total}\n\n"
        f"STORY SO FAR (already written, for continuity only — do not repeat it):\n{context}\n\n"
        "Continue the narrative from exactly where it left off, in the SAME past-tense prose "
        "voice, one continuous story — and if the missing panel(s) include the last panel, "
        "land a real ending, not a cliffhanger.\n\n"
        "CHILD-SAFE, ALWAYS: warm, gentle, wonder-filled — no violence, weapons, blood/gore, "
        "death, scary or frightening imagery, horror, adult themes, or innuendo.\n\n"
        "Emit ONLY these two event types, one compact JSON object per line, nothing else (no "
        "prose, no markdown fences) — one art line and one caption line per missing panel:\n"
        '{"t":"panel.art","panel":<int>,"svg":"<a ONE-SENTENCE image prompt describing the picture>"}\n'
        '{"t":"panel.caption","panel":<int>,"text":"<the story caption for this panel, continuing the narrative>","dim":false}\n'
        f"Only emit these for panel numbers in: {panel_list}. No other panels, no other event types, "
        "no commentary."
    )


# Event `t` values the bridge will accept; anything else is dropped as noise.
KNOWN_EVENTS = {
    "brief", "agent", "panel.status", "panel.art", "panel.caption",
    "panel.note", "log", "progress", "focus", "run.done",
}
