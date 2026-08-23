# embed/agent-embed.js

The one piece of Inkwell Studio's front-end that's genuinely reusable outside this demo:
an SSE client with a `start(onEvent)`/`stop()` interface, extracted from `app.js`. See its
own file header for the full reasoning, and
`demos/inkwell-studio/docs/productization-architecture.md` for how this fits into the wider
before/after picture.

Everything else in this demo's front-end (the reducer, panel rendering, narration, the
flip-book/GIF/PDF exports, restyle/regenerate) stays in `app.js` — it's deeply specific to
Inkwell's storybook UI (DOM ids, CSS classes, a 1000+-line hand-tuned rendering layer), and a
second consumer that would justify pulling it into a generic core doesn't exist yet. Building
that split now, for a hypothetical future app, would mean rewriting a lot of carefully-tuned
working code for no proven benefit — see the plan discussion this came out of. What's here is
exactly the surface area that was already clean and dependency-free.

## Usage

```js
import { AgentEmbedSource } from './agent-embed.js';

const source = new AgentEmbedSource(
  { idea, style, panels: String(total) },   // opaque query params -- match your bridge's /events
  {
    onFatal: (msg) => { /* connection never opened, or dropped before anything usable arrived */ },
    token: myScopedToken,                   // omit if your bridge has no INKWELL_API_TOKEN-equivalent set
    eventsPath: '/events',                  // default; point elsewhere if your bridge differs
  },
);
source.start((event) => { /* your own reducer, e.g. Inkwell's apply(event) in app.js */ });
// later: source.stop();
```

`token` rides as a `?token=` query param (not a header) because browsers' native
`EventSource` can't set custom headers — see
`packages/a2a-embed/a2a_embed/auth.py`'s docstring for the tradeoff that implies. Your
bridge needs to be built with `a2a_embed.server.sse_route(..., token_env_var=...)` (or an
equivalent check) for this to mean anything; Inkwell's own `server/bridge.py` shows the shape.

## What you still have to write yourself

A different app reusing this class still needs its own:
- event vocabulary + guided-protocol prompt (`server/prompt.py`'s equivalent — see
  `packages/a2a-embed/README.md`'s "wiring a new app" section),
- reducer + renderer (`app.js`'s `apply(event)` and the `render*` functions are Inkwell's;
  yours will look nothing like them once you're past the four generic event types
  `agent`/`progress`/`log`/`run.done`).
