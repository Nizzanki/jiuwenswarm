// Minimal EN/中文 toggle for Inkwell Studio's own UI chrome (labels, buttons, status copy,
// the exported storybook's own chrome). This is a SEPARATE concern from the generated
// story's language: the story's language is decided server-side (server/prompt.py's
// explicit lang override, threaded through server/bridge.py) using the same toggle value —
// this file only swaps what the page itself says around that content.
//
// No framework: a flat EN/ZH dictionary + a tiny `t(key)` lookup, applied to the static DOM
// via `data-i18n`/`data-i18n-html`/`data-i18n-placeholder`/`data-i18n-title` attributes
// (applyStaticI18n), and called directly from app.js wherever text is built dynamically.

const STORAGE_KEY = 'inkwell-lang';

export const DICT = {
  en: {
    docTitle: 'Inkwell Studio — powered by JiuwenSwarm over A2A',

    'notice.b': 'Story Studio · Path 2',
    'notice.span': 'Your own studio UI with JiuwenSwarm running as a service behind it, over A2A — '
      + 'a leader agent spawns Writer &amp; Critic teammates who genuinely draft, reject and revise '
      + 'the story (~1–3 min). Type an idea, press <strong>Go</strong>.',

    'brand.sub': 'An illustrated story, made by a crew of agents',
    'powered.html': 'a custom studio front-end<br>crew: <span class="swarm">JiuwenSwarm swarm</span> over A2A',

    'arch.cap': 'How one run travels — Path 2 (JiuwenSwarm as a service)',
    'arch.n1.k': '1 · Your app', 'arch.n1.t': 'Studio UI (this page)',
    'arch.n1.d': 'Author types one story idea + a style.',
    'arch.a1': 'JSON-RPC',
    'arch.n2.k': '2 · Transport', 'arch.n2.t': 'A2A', 'arch.n2.d': 'Standard agent endpoint',
    'arch.a2': 'the brief',
    'arch.n3.k': '3 · JiuwenSwarm', 'arch.n3.t': 'Jiuwen Team',
    'arch.n3.d': 'Writer · Art Director · Image Gen · Editor · Critic build the story panel by panel.',
    'arch.a3': 'panels: image + caption + status (JSON)',

    'lang.toggle.title': 'Switch to Chinese UI — also makes the crew write the story in Chinese',

    'idea.label': 'Story idea',
    'idea.placeholder': 'One sentence: who, and what happens?',
    'surprise.title': 'Fill in a random idea',
    'style.label': 'Style', 'style.placeholder': '…or type your own',
    'style.presetPlaceholder': 'Presets…',
    'style.preset.storybook': 'Warm storybook · Painterly',
    'style.preset.noir': 'Inky noir · High contrast',
    'style.preset.watercolor': 'Soft watercolor · Dreamy',
    'style.preset.comic': 'Retro comic · Bold ink',
    'style.preset.coloring': 'Coloring book · Black & white line art',
    'count.label': 'Panels',
    'go.idle': 'Go', 'go.running': 'Running…', 'go.again': 'Run again',

    'brief.l': 'The author asked for',
    'gallery.empty.html': 'Press <b>Go</b> to send the brief to the crew — panels will appear '
      + 'here as they’re drawn.',
    'run.contacting': 'Contacting the JiuwenSwarm crew over A2A… first panels take ~20–40s while '
      + 'the story is written.',

    'restyle.name': 'Restyle', 'restyle.meta': 'same text · same prompts',
    'restyle.button': '🎨 Restyle images', 'restyle.button.title': 'Same text, same prompts — new style. Live mode only.',
    'restyle.busy': '⟳ Restyling…',

    'storySoFar.name': 'Story so far', 'storySoFar.meta': 'The Loom',
    'prog.idle.lead': 'Idle', 'prog.idle.sub': '· press Go to begin',
    'prog.done.lead': 'Story complete',
    'prog.done.sub': (total) => `· all ${total} panels approved`,
    'prog.running.lead': (approved) => `${approved} approved`,
    'prog.running.sub': (inReview, drafting, total) =>
      `· ${inReview} in review · ${drafting} drafting · ~${total} total`,
    'loop.panel': (n) => `Panel ${n}`,
    'readStory.idle': '🔊 Read story aloud', 'readStory.reading': '⏹ Stop reading',
    'pauseStory.pause': '⏸ Pause', 'pauseStory.resume': '▶ Resume',
    'readSpeed.label': 'Reading speed', 'readSpeed.slow': 'Slow', 'readSpeed.normal': 'Normal', 'readSpeed.fast': 'Fast',
    'download.html': '⤓ Download story (HTML)',
    'download.gif': '⤓ Download GIF', 'download.gif.busy': '⟳ Rendering GIF…',
    'download.pdf': '⤓ Download PDF', 'download.pdf.busy': '⟳ Rendering PDF…',

    'crew.name': 'Jiuwen Team', 'crew.meta': '5 agents ·',
    'crew.live': 'live', 'crew.idle': 'idle', 'crew.done': 'done',

    'loop.title': 'Revision loop', 'loop.meta': 'handoffs',
    'loop.empty': 'The Critic↔Writer loop shows up here when a panel gets sent back.',

    'fulltext.name': 'The story · full text',
    'fulltext.empty': 'The finished story appears here once a run completes.',
    'fulltext.debugSummary': 'Debug · what the crew produced per panel',

    'legend.1.n': 'The gallery — your UI',
    'legend.1.p': 'Panels, images and captions are <em>your</em> app’s components. The swarm '
      + 'returns each panel as data (image + caption + status); your front-end lays out the storybook.',
    'legend.2.n': 'Jiuwen Team — the swarm made visible',
    'legend.2.p': 'The differentiator: you <em>watch</em> the Critic reject a panel and the Writer '
      + 'revise it. Agents improving each other’s work is the whole show.',
    'legend.3.n': 'The revision loop — why a team',
    'legend.3.p': 'A single AI hands you one draft, take it or leave it. The Critic↔Writer loop is '
      + 'what turns a rough panel into a good one — and it needs separate agents to exist.',

    'footnote.html': '<b>Path 2 notes:</b> this studio is a standalone app talking to JiuwenSwarm '
      + 'over A2A, so your front-end renders these panels from the swarm’s JSON (A2UI isn’t used — '
      + 'that’s the trade for the cleaner “embedded engine” story). The UI is driven by a normalized '
      + 'event stream coming straight from the bridge’s SSE endpoint.',

    // ---- dynamic (app.js) ----
    'agent.writer': 'Writer', 'agent.critic': 'Critic', 'agent.artDirector': 'Art Director',
    'agent.imageGen': 'Image Gen', 'agent.editor': 'Editor',
    'agent.label.tool': 'tool',
    'state.active': 'working', 'state.done': 'done', 'state.idle': 'idle', 'state.reject': 'rejected',
    'say.drafting': 'Drafting…', 'say.rendering': 'Rendering…', 'say.revising': 'Revising…',
    'say.queued': 'Queued…', 'say.review': 'Reviewing…', 'say.working': 'Working…',
    // Short state-badge words (no ellipsis) for the crew card's `state` field — the model's
    // own protocol emits these as fixed English tokens (prompt.py's `agent.state`), so the
    // raw value needs translating for display same as everything else.
    'word.drafting': 'drafting', 'word.rendering': 'rendering', 'word.revising': 'revising',
    'word.queued': 'queued', 'word.review': 'review', 'status.approved': 'approved',
    'say.writer.idle': 'Ready when you are.', 'say.critic.idle': 'Standing by to review.',
    'say.artDirector.idle': 'Waiting for the first beat.', 'say.imageGen.idle': 'No panels rendered yet.',
    'say.editor.idle': 'Watching the flow.', 'say.standby': 'Standing by.',

    'pill.drafting': 'Drafting', 'pill.rendering': 'Rendering', 'pill.review': 'In review',
    'panel.revising': 'Revising…', 'panel.captionPending': '— caption pending —',
    'panel.rendering': 'rendering…', 'panel.artDirectorLabel': 'Art Director · image prompt',
    'panel.imagePromptTag': '🎨 image prompt', 'panel.noImage': 'no image',
    'panel.writerAtWork': 'Writer at work…',
    'panel.regen': '↻ Redo image', 'panel.regenBusy': '⟳ Redrawing…',
    'panel.regen.title': 'Redo this image — same caption, a fresh picture',
    'panel.imagePending': 'image pending',
    'panel.editText': '✎ Edit text', 'panel.editText.title': 'Edit this panel\'s text yourself',
    'panel.rewriteText': '↻ Rewrite text', 'panel.rewriteBusy': '⟳ Rewriting…',
    'panel.rewriteText.title': 'Rewrite this panel\'s text — same picture, fresh words',
    'panel.saveText': 'Save', 'panel.checkBusy': 'Checking…', 'panel.cancelEdit': 'Cancel',
    'panel.editHint': 'Checked for child safety before it\'s saved',
    'panel.editEmpty': 'The text can\'t be empty.',
    'panel.editRejected': (reason) => `This text didn't pass the child-safety check${reason ? ` (${reason})` : ''}. Please change it and try again.`,
    'panel.editCheckFailed': (msg) => `Couldn't check this text (${msg}), so it wasn't saved. Needs the bridge running.`,
    'panel.rewriteFailed': (msg) => `Couldn't rewrite this panel's text (${msg}) — kept the current text.`,

    'ft.panels': (n) => `${n} panel${n > 1 ? 's' : ''}`,
    'ft.words': (n) => `${n} word${n === 1 ? '' : 's'}`,
    'ft.rejected': '✕ Rejected', 'ft.approved': '✓ Approved',
    'ft.revised': 'revised', 'ft.panelHeading': (num) => `Panel ${num}`,
    'ft.critic': 'critic', 'ft.caption': 'caption', 'ft.imagePrompt': 'image prompt', 'ft.image': 'image',
    'ft.rendered': (kb) => `rendered · ~${kb} KB`, 'ft.placeholder': '— (placeholder)',

    'note.criticLabel': 'Critic → sent back',

    'livenote.narrateFailed': (msg) => `Couldn't read the story aloud (${msg}). Needs the bridge running.`,
    'livenote.narratePlayFailed': "Couldn't play the story's narration.",
    'livenote.gifFailed': (msg) => `Couldn't build the GIF (${msg}). GIF export needs the bridge running.`,
    'livenote.pdfFailed': (msg) => `Couldn't build the PDF (${msg}). PDF export needs the bridge running.`,
    'livenote.restyleFailed': (msg) => `Couldn't restyle (${msg}). Restyle needs the bridge running.`,
    'livenote.restylePartial': (n) => `${n} panel${n > 1 ? 's' : ''} couldn't be restyled — kept the previous image.`,
    'livenote.regenFailed': (n, err) => `Couldn't redo panel ${n}'s image${err ? ` (${err})` : ''}`,
    'livenote.regenFailedNetwork': (n, msg) => `Couldn't redo panel ${n}'s image (${msg}). Needs the bridge running.`,
    'livenote.keptPrevious': ' — kept the previous picture.',
    'livenote.period': '.',
    'livenote.runEndedMidRender': 'run ended before this panel finished rendering',
    'livenote.renderFailed': 'render failed',

    'export.eyebrow': 'Inkwell Studio', 'export.turnPage': 'turn the page to begin →',
    'export.theEnd': 'The End',
    'export.closing.html': 'An illustrated story, made by a crew of agents<br>powered by JiuwenSwarm over A2A',
    'export.goToPage': (n) => `Go to page ${n}`,
    'export.prevPage': 'Previous page', 'export.nextPage': 'Next page',

    'surpriseIdeas': [
      'A lonely lighthouse keeper befriends a sea monster.',
      'A shy dragon just wants someone to read books with.',
      'A little cloud loses her rain and asks the animals for help.',
      'A snail dreams of racing the wind and finally gets his chance.',
      'A grumpy old oak tree learns to share its shade with a new sapling.',
      "A firefly who can't glow yet borrows light from the stars.",
      'Two rival garden gnomes team up to save the vegetable patch.',
      'A young otter finds a lost mitten and searches the whole river for its owner.',
      'A sleepy bear tries to stay awake to see the first snow.',
      'A paper boat sets sail to find where the stream ends.',
      "A tiny mole who's afraid of the dark discovers she can glow.",
      'A young owl is scared of heights but must learn to fly before winter.',
      'A scarecrow secretly longs to dance with the cornstalks at night.',
      'A hedgehog too prickly for hugs invents a soft blanket instead.',
      'A whale sings the same song every night, hoping someone finally sings back.',
    ],
  },

  zh: {
    docTitle: 'Inkwell Studio — 由 JiuwenSwarm 通过 A2A 驱动',

    'notice.b': '故事工坊 · 路径二',
    'notice.span': '你自己的工坊界面，背后由 JiuwenSwarm 以服务的形式运行，通过 A2A 通信 —— '
      + '一位主管代理会召集"撰稿人"与"评审"队友，真正地起草、驳回并修订故事（约 1–3 分钟）。'
      + '输入一个故事点子，按下<strong>开始</strong>。',

    'brand.sub': '一个由代理团队创作的插画故事',
    'powered.html': '自定义的工坊前端<br>团队：<span class="swarm">JiuwenSwarm 群组</span>（通过 A2A）',

    'arch.cap': '一次运行的完整路径 — 路径二（JiuwenSwarm 作为服务）',
    'arch.n1.k': '1 · 你的应用', 'arch.n1.t': '工坊界面（本页）',
    'arch.n1.d': '作者输入一个故事点子和一种风格。',
    'arch.a1': 'JSON-RPC',
    'arch.n2.k': '2 · 传输层', 'arch.n2.t': 'A2A', 'arch.n2.d': '标准代理端点',
    'arch.a2': '简报',
    'arch.n3.k': '3 · JiuwenSwarm', 'arch.n3.t': '九问团队',
    'arch.n3.d': '撰稿人 · 美术指导 · 图像生成 · 编辑 · 评审逐格构建故事。',
    'arch.a3': '分格：图像 + 文字 + 状态（JSON）',

    'lang.toggle.title': '切换为英文界面',

    'idea.label': '故事点子',
    'idea.placeholder': '一句话：谁，发生了什么？',
    'surprise.title': '随机填入一个点子',
    'style.label': '风格', 'style.placeholder': '…或自行输入',
    'style.presetPlaceholder': '预设…',
    'style.preset.storybook': '温暖绘本 · 油画感',
    'style.preset.noir': '墨黑悬疑 · 高对比度',
    'style.preset.watercolor': '柔和水彩 · 梦幻感',
    'style.preset.comic': '复古漫画 · 粗墨线条',
    'style.preset.coloring': '涂色绘本 · 黑白线稿',
    'count.label': '分格数',
    'go.idle': '开始', 'go.running': '运行中…', 'go.again': '再来一次',

    'brief.l': '作者的要求是',
    'gallery.empty.html': '按下<b>开始</b>，把简报发给团队 —— 分格会在绘制时逐一出现。',
    'run.contacting': '正在通过 A2A 联系 JiuwenSwarm 团队… 故事撰写期间，第一批分格约需 20–40 秒。',

    'restyle.name': '换个风格', 'restyle.meta': '文字不变 · 图像提示不变',
    'restyle.button': '🎨 重绘图像', 'restyle.button.title': '文字和图像提示不变 —— 只换风格。仅实时模式可用。',
    'restyle.busy': '⟳ 重绘中…',

    'storySoFar.name': '目前的故事', 'storySoFar.meta': '织机',
    'prog.idle.lead': '空闲', 'prog.idle.sub': '· 按开始启动',
    'prog.done.lead': '故事完成',
    'prog.done.sub': (total) => `· 全部 ${total} 格均已通过`,
    'prog.running.lead': (approved) => `${approved} 格已通过`,
    'prog.running.sub': (inReview, drafting, total) =>
      `· ${inReview} 格审阅中 · ${drafting} 格起草中 · 共约 ${total} 格`,
    'loop.panel': (n) => `第 ${n} 格`,
    'readStory.idle': '🔊 朗读故事', 'readStory.reading': '⏹ 停止朗读',
    'pauseStory.pause': '⏸ 暂停', 'pauseStory.resume': '▶ 继续',
    'readSpeed.label': '朗读速度', 'readSpeed.slow': '慢', 'readSpeed.normal': '正常', 'readSpeed.fast': '快',
    'download.html': '⤓ 下载故事（HTML）',
    'download.gif': '⤓ 下载 GIF', 'download.gif.busy': '⟳ 正在生成 GIF…',
    'download.pdf': '⤓ 下载 PDF', 'download.pdf.busy': '⟳ 正在生成 PDF…',

    'crew.name': '九问团队', 'crew.meta': '5 位代理 ·',
    'crew.live': '实时', 'crew.idle': '空闲', 'crew.done': '完成',

    'loop.title': '修订循环', 'loop.meta': '交接记录',
    'loop.empty': '当某一格被打回修改时，评审↔撰稿人的往来会显示在这里。',

    'fulltext.name': '故事全文',
    'fulltext.empty': '运行完成后，完整故事会显示在这里。',
    'fulltext.debugSummary': '调试 · 团队每一格的产出',

    'legend.1.n': '画廊 — 你的界面',
    'legend.1.p': '分格、图像和文字都是<em>你的</em>应用的组件。群组把每一格作为数据返回'
      + '（图像 + 文字 + 状态）；你的前端负责把它们排版成故事书。',
    'legend.2.n': '九问团队 — 让群组可见',
    'legend.2.p': '差异化之处：你能<em>亲眼看到</em>评审驳回一格，撰稿人再修订它。'
      + '代理们互相改进对方的工作，就是这场演示的核心。',
    'legend.3.n': '修订循环 — 为什么需要团队',
    'legend.3.p': '单个 AI 只会给你一份草稿，接受或放弃。评审↔撰稿人的循环才能把一格粗糙的内容'
      + '打磨成好内容 —— 而这需要独立的代理才能实现。',

    'footnote.html': '<b>路径二说明：</b>这个工坊是一个独立应用，通过 A2A 与 JiuwenSwarm 通信，'
      + '因此你的前端是根据群组返回的 JSON 来渲染这些分格的（没有使用 A2UI —— 这是为了换取更干净的'
      + '"内嵌引擎"叙事而做的取舍）。界面由桥接服务 SSE 端点直接提供的标准化事件流驱动。',

    // ---- dynamic (app.js) ----
    'agent.writer': '撰稿人', 'agent.critic': '评审', 'agent.artDirector': '美术指导',
    'agent.imageGen': '图像生成', 'agent.editor': '编辑',
    'agent.label.tool': '工具',
    'state.active': '进行中', 'state.done': '完成', 'state.idle': '空闲', 'state.reject': '已驳回',
    'say.drafting': '起草中…', 'say.rendering': '渲染中…', 'say.revising': '修订中…',
    'say.queued': '排队中…', 'say.review': '审阅中…', 'say.working': '工作中…',
    'word.drafting': '起草中', 'word.rendering': '渲染中', 'word.revising': '修订中',
    'word.queued': '排队中', 'word.review': '审阅中', 'status.approved': '已通过',
    'say.writer.idle': '随时待命。', 'say.critic.idle': '待命审阅中。',
    'say.artDirector.idle': '等待第一个分镜。', 'say.imageGen.idle': '还没有分格被渲染。',
    'say.editor.idle': '关注整体流程。', 'say.standby': '待命中。',

    'pill.drafting': '起草中', 'pill.rendering': '渲染中', 'pill.review': '审阅中',
    'panel.revising': '修订中…', 'panel.captionPending': '— 文字待定 —',
    'panel.rendering': '渲染中…', 'panel.artDirectorLabel': '美术指导 · 图像提示',
    'panel.imagePromptTag': '🎨 图像提示', 'panel.noImage': '无图像',
    'panel.writerAtWork': '撰稿人正在创作…',
    'panel.regen': '↻ 重新绘制', 'panel.regenBusy': '⟳ 重绘中…',
    'panel.regen.title': '重新绘制这张图 —— 文字不变，重新生成图像',
    'panel.imagePending': '图像待定',
    'panel.editText': '✎ 编辑文字', 'panel.editText.title': '亲自编辑这一格的文字',
    'panel.rewriteText': '↻ 重写文字', 'panel.rewriteBusy': '⟳ 重写中…',
    'panel.rewriteText.title': '重写这一格的文字 —— 图像不变，换一种写法',
    'panel.saveText': '保存', 'panel.checkBusy': '检查中…', 'panel.cancelEdit': '取消',
    'panel.editHint': '保存前会进行儿童安全检查',
    'panel.editEmpty': '文字不能为空。',
    'panel.editRejected': (reason) => `这段文字未通过儿童安全检查${reason ? `（${reason}）` : ''}。请修改后再试。`,
    'panel.editCheckFailed': (msg) => `无法检查这段文字（${msg}），因此未保存。需要桥接服务正在运行。`,
    'panel.rewriteFailed': (msg) => `无法重写这一格的文字（${msg}）—— 已保留原文字。`,

    'ft.panels': (n) => `${n} 格`,
    'ft.words': (n) => `${n} 字`,
    'ft.rejected': '✕ 已驳回', 'ft.approved': '✓ 已通过',
    'ft.revised': '已修订', 'ft.panelHeading': (num) => `第 ${num} 格`,
    'ft.critic': '评审', 'ft.caption': '文字', 'ft.imagePrompt': '图像提示', 'ft.image': '图像',
    'ft.rendered': (kb) => `已渲染 · 约 ${kb} KB`, 'ft.placeholder': '— （占位图） —',

    'note.criticLabel': '评审 → 已打回',

    'livenote.narrateFailed': (msg) => `无法朗读故事（${msg}）。需要桥接服务正在运行。`,
    'livenote.narratePlayFailed': '无法播放故事的朗读音频。',
    'livenote.gifFailed': (msg) => `无法生成 GIF（${msg}）。GIF 导出需要桥接服务正在运行。`,
    'livenote.pdfFailed': (msg) => `无法生成 PDF（${msg}）。PDF 导出需要桥接服务正在运行。`,
    'livenote.restyleFailed': (msg) => `无法重绘风格（${msg}）。需要桥接服务正在运行。`,
    'livenote.restylePartial': (n) => `有 ${n} 格未能重绘 —— 已保留原图。`,
    'livenote.regenFailed': (n, err) => `无法重绘第 ${n} 格的图像${err ? `（${err}）` : ''}`,
    'livenote.regenFailedNetwork': (n, msg) => `无法重绘第 ${n} 格的图像（${msg}）。需要桥接服务正在运行。`,
    'livenote.keptPrevious': ' —— 已保留原图。',
    'livenote.period': '。',
    'livenote.runEndedMidRender': '运行结束时这一格还没渲染完成',
    'livenote.renderFailed': '渲染失败',

    'export.eyebrow': 'Inkwell Studio', 'export.turnPage': '翻页开始阅读 →',
    'export.theEnd': '全文完',
    'export.closing.html': '一个由代理团队创作的插画故事<br>由 JiuwenSwarm 通过 A2A 驱动',
    'export.goToPage': (n) => `跳转到第 ${n} 页`,
    'export.prevPage': '上一页', 'export.nextPage': '下一页',

    'surpriseIdeas': [
      '一位孤独的灯塔看守人和一只海怪成为了朋友。',
      '一只害羞的小龙只想找个人一起读书。',
      '一朵小云失去了她的雨水，向动物们求助。',
      '一只蜗牛梦想和风赛跑，终于等来了机会。',
      '一棵脆躁的老橡树学会了与新来的小树苗分享树荫。',
      '一只还不会发光的萤火虫，向星星借来了光。',
      '两只互相竞争的花园地精联手拯救了菜园。',
      '一只小水獭捡到一只丢失的手套，沿着整条河寻找它的主人。',
      '一只贪睡的小熊努力撑着不睡，想看看今年的第一场雪。',
      '一只纸船出发去寻找小溪的尽头。',
      '一只怕黑的小鼹鼠发现自己原来会发光。',
      '一只怕高的小猫头鹰必须在冬天到来前学会飞翔。',
      '一个稻草人悄悄渴望在夜里和玉米杆们一起跳舞。',
      '一只浑身是刺、无法拥抱的小刺猬，为自己发明了一条软毯子。',
      '一头鲸鱼每晚都唱着同一首歌，盼着终于有谁能唱出回应。',
    ],
  },
};

let lang = 'en';
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'en' || saved === 'zh') lang = saved;
} catch { /* localStorage unavailable (private window etc.) — default to 'en' */ }

export function getLang() { return lang; }

export function setLang(next) {
  lang = next === 'zh' ? 'zh' : 'en';
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* best-effort persistence only */ }
}

// `t(key, ...args)` — looks up `key` in the current language, falling back to English, then
// to the raw key (so a missing translation shows as a visible string, not a crash). If the
// resolved value is a function (interpolated strings like livenote.*), call it with `args`.
export function t(key, ...args) {
  const entry = (DICT[lang] && DICT[lang][key] !== undefined) ? DICT[lang][key]
    : (DICT.en[key] !== undefined ? DICT.en[key] : key);
  return typeof entry === 'function' ? entry(...args) : entry;
}

export function surpriseIdeas() {
  return DICT[lang].surpriseIdeas;
}

export function applyStaticI18n() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = t('docTitle');
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
}
