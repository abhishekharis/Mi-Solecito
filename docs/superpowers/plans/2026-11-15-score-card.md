# Score Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the Fetch Game ends, push score data from the agent to a companion web page at `/scoreboard` that renders Variant B (score card with word chips) in real time.

**Architecture:** Agent POSTs `ScorePayload` to `POST /score` on the existing Hono server when `next_item` returns `done: true`. The score card page at `GET /scoreboard` polls `GET /score` every second and renders the card when data arrives. The store is in-memory — a new game's POST simply overwrites the previous score, so "play again" re-renders the card automatically.

**Tech Stack:** TypeScript/ESM, Hono (`@hono/node-server`), native `fetch` (agent → server), HTML/CSS/JS (score-card.html, no framework), no new npm dependencies.

**Spec:** Settled in conversation — Variant B score card, triggers on Fetch Game completion only, visual companion to agent's verbal score announcement. Show & Say has no score and gets no card.

## Global Constraints

- No new npm dependencies
- score-card.html is a single self-contained HTML file — inline all CSS and JS, no external scripts
- Google Fonts (`fonts.googleapis.com`) is the only allowed external resource
- PORT env var (default `3000`) is used for the webhook server and the score card page — no separate port
- start.sh must start `dist/server.js` and kill it on restart (currently missing — fix in Task 2)
- .env must NOT be committed (contains secrets)

## Review Focus

- **Play again re-renders the card:** a second POST with a new `timestamp` must replace the displayed card within ≤1 second; card must not freeze on the first game's data.
- **Waiting state before first game:** opening `/scoreboard` before any game completes must show a "Waiting..." UI, never a crash or empty screen.
- **`translation: null` in preset fallback items:** word chips must fall back to `english` when `translation` is null; never render "null" as text.
- **Language-to-flag mapping:** `state.targetLanguage` is a free-form string from the user (e.g. "Spanish", "french", "JAPANESE"); flag lookup must be case-insensitive and fall back to 🌍 for unknown languages.
- **server.ts not started in start.sh:** existing start.sh never launches `dist/server.js`; score endpoints are unreachable until this is fixed.

---

### Task 1: Track per-word correctness in game.ts

**Files:**
- Modify: `src/game.ts`

**Interfaces:**
- Produces: `FetchItem.correct?: boolean` — set to `wasCorrect` by `advanceFetch` before the index advances; `undefined` on items not yet attempted

- [ ] **Step 1: Add `correct?: boolean` to `FetchItem`**

In `src/game.ts`, in the `FetchItem` interface, add after the `hint` field:
```typescript
correct?: boolean;
```

- [ ] **Step 2: Mark item in `advanceFetch` before scoring**

In `advanceFetch`, as the first line of the function body (before `if (wasCorrect) state.score++`):
```typescript
state.fetchList[state.currentIndex]!.correct = wasCorrect;
```

- [ ] **Step 3: Verify with tsc**

Run: `npx tsc --noEmit`
Expected: zero type errors

- [ ] **Step 4: Commit**

```bash
git add src/game.ts
git commit -m "feat: track per-word correctness in FetchItem

Adds correct?: boolean to FetchItem, set by advanceFetch before
advancing the index. Needed to populate score card word chips.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Add score endpoints to server.ts + fix start.sh

**Files:**
- Modify: `src/server.ts`
- Modify: `start.sh`

**Interfaces:**
- Produces:
  - `POST /score` — body: `ScorePayload`, stores in `latestScore`, returns `{ ok: true }`
  - `GET /score` — returns `ScorePayload` if one exists, else `{ waiting: true }`
  - `GET /scoreboard` — returns `score-card.html` as `text/html` (file read at request time; returns 500 if not yet built — fixed by Task 3)

**ScorePayload** (define at top of server.ts, after imports):
```typescript
interface ScorePayload {
  score: number;
  total: number;
  words: { english: string; translation: string | null; correct: boolean }[];
  language: string;
  timestamp: number;
}
```

- [ ] **Step 1: Add Node built-in imports to server.ts**

At the top of `src/server.ts`, add after the existing imports:
```typescript
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
```

- [ ] **Step 2: Add `ScorePayload` type and `latestScore` store**

After the imports, add:
```typescript
interface ScorePayload {
  score: number;
  total: number;
  words: { english: string; translation: string | null; correct: boolean }[];
  language: string;
  timestamp: number;
}
let latestScore: ScorePayload | null = null;
```

- [ ] **Step 3: Add `POST /score` route**

After the existing `/health` route:
```typescript
app.post('/score', async (c) => {
  latestScore = await c.req.json<ScorePayload>();
  return c.json({ ok: true });
});
```

- [ ] **Step 4: Add `GET /score` route**

```typescript
app.get('/score', (c) => {
  if (!latestScore) return c.json({ waiting: true });
  return c.json(latestScore);
});
```

- [ ] **Step 5: Add `GET /scoreboard` route**

```typescript
app.get('/scoreboard', (c) => {
  const __dir = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(join(__dir, 'score-card.html'), 'utf-8');
  return c.html(html);
});
```

- [ ] **Step 6: Fix start.sh — kill and start server.js**

In `start.sh`, in the kill block (step 1), add:
```bash
pkill -9 -f "dist/server.js" 2>/dev/null || true
```

After `echo "✓ Build OK"` (step 2), add before the agent start:
```bash
# ── 2b. Start webhook server ─────────────────────────
echo "→ Starting webhook server..."
node dist/server.js &
SERVER_PID=$!
sleep 1
echo "✓ Webhook server started (PID $SERVER_PID)"
```

- [ ] **Step 7: Verify endpoints with curl**

Build and start only the server: `node dist/server.js &`

```bash
# Should return {"waiting":true}
curl -s http://localhost:3000/score

# Post a mock score
curl -s -X POST http://localhost:3000/score \
  -H 'Content-Type: application/json' \
  -d '{"score":4,"total":5,"words":[{"english":"cup","translation":"la taza","correct":true},{"english":"pen","translation":null,"correct":false}],"language":"Spanish","timestamp":1000}'

# Should return the posted payload
curl -s http://localhost:3000/score

# Should return 500 (score-card.html doesn't exist yet — expected)
curl -o /dev/null -w "%{http_code}" http://localhost:3000/scoreboard
```

Expected: first curl returns `{"waiting":true}`, second returns `{"ok":true}`, third returns the full payload, fourth returns `500`.

- [ ] **Step 8: Verify with tsc**

Run: `npx tsc --noEmit`
Expected: zero errors

- [ ] **Step 9: Commit**

```bash
git add src/server.ts start.sh
git commit -m "feat: add score endpoints to server + fix start.sh to run server

POST /score stores ScorePayload, GET /score returns it (or waiting),
GET /scoreboard serves score-card.html. start.sh now starts and kills
dist/server.js.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Build score-card.html

**Files:**
- Create: `src/score-card.html`
- Modify: `start.sh` (add HTML copy step after build)

**Interfaces:**
- Consumes: `GET /score` → `ScorePayload | { waiting: true }` (from Task 2)
- `ScorePayload.words[n].translation` may be `null` — render `english` as fallback

**Page behaviour:**
- Polls `GET /score` every 1000 ms
- If response is `{ waiting: true }`, show "Waiting..." state; keep polling
- If response is `ScorePayload`:
  - Render score (e.g. `4 / 5`), language flag + name, word chips, share button
  - Store `timestamp`; keep polling — if a later response has a different `timestamp`, re-render (handles "play again")
- Language-to-flag map, case-insensitive: `spanish→🇪🇸`, `french→🇫🇷`, `japanese→🇯🇵`, `portuguese→🇧🇷`, `german→🇩🇪`, `italian→🇮🇹`; default `🌍`
- Share button copies a text summary to clipboard

**Design tokens** (match the prototype):
- `--accent: #D4700A` (light) / `#F28C3A` (dark)
- `--success: #1A7F4B` / `#34C97A`; `--miss: #B91C1C` / `#F87171`
- Fonts: Space Grotesk (headings/score) + Inter (body) from Google Fonts
- Full dark mode via `prefers-color-scheme` + `[data-theme]` toggle

- [ ] **Step 1: Create `src/score-card.html`**

Single `.html` file. Structure:

```
<title>Mi Solecito Score</title>
<link rel=stylesheet href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700;800&family=Inter:wght@400;500;600&display=swap">
<style>
  :root { /* light tokens */ }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { /* dark tokens */ } }
  :root[data-theme="dark"] { /* same dark tokens */ }
  body { background: var(--bg); color: var(--fg); font-family: 'Inter'... }
  /* waiting state, card layout, chip styles */
</style>

<div id="waiting"> ... pulsing animation ... </div>
<div id="card" hidden> ... score, chips, share button ... </div>

<script>
  const FLAGS = { spanish:'🇪🇸', french:'🇫🇷', japanese:'🇯🇵', portuguese:'🇧🇷', german:'🇩🇪', italian:'🇮🇹' };
  let lastTimestamp = null;

  function render(data) { /* populate #card, show it, hide #waiting */ }

  async function poll() {
    try {
      const res = await fetch('/score');
      const data = await res.json();
      if (!data.waiting && data.timestamp !== lastTimestamp) {
        lastTimestamp = data.timestamp;
        render(data);
      }
    } catch {}
  }

  poll();
  setInterval(poll, 1000);
</script>
```

- [ ] **Step 2: Add HTML copy step to start.sh**

In `start.sh`, after `npm run build` (before the server start), add:
```bash
cp src/score-card.html dist/score-card.html
```

- [ ] **Step 3: Verify "waiting" state**

Build, start server (`node dist/server.js`), do NOT post any score.
Open `http://localhost:3000/scoreboard`.
Expected: "Waiting for game to end..." UI visible, no JS errors in console.

- [ ] **Step 4: Verify score renders**

With the page open, POST a score:
```bash
curl -s -X POST http://localhost:3000/score \
  -H 'Content-Type: application/json' \
  -d '{"score":4,"total":5,"words":[{"english":"cup","translation":"la taza","correct":true},{"english":"pen","translation":null,"correct":false},{"english":"lamp","translation":"la lámpara","correct":true},{"english":"bottle","translation":"la botella","correct":true},{"english":"key","translation":"la llave","correct":false}],"language":"Spanish","timestamp":1000}'
```
Expected within 1 second: card renders — "4 / 5", 🇪🇸 Spanish, green chips for cup/lamp/bottle, red chips for pen (shows "pen" since translation is null) and key.

- [ ] **Step 5: Verify "play again" re-renders**

POST a second payload with a different `timestamp`:
```bash
curl -s -X POST http://localhost:3000/score \
  -H 'Content-Type: application/json' \
  -d '{"score":5,"total":5,"words":[{"english":"book","translation":"el libro","correct":true}],"language":"French","timestamp":2000}'
```
Expected within 1 second: card updates — "5 / 5", 🇫🇷 French, one green chip.

- [ ] **Step 6: Commit**

```bash
git add src/score-card.html start.sh
git commit -m "feat: add score-card.html and copy to dist in start.sh

Variant B score card: polls /score every 1s, renders on completion,
re-renders on play-again (different timestamp). Waiting state shown
before first game ends.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Push score from agent.ts when game ends

**Files:**
- Modify: `src/agent.ts`

**Interfaces:**
- Consumes: `gameState.fetchList` (`FetchItem[]` with `correct?: boolean` from Task 1), `gameState.score`, `state.targetLanguage`, `process.env.PORT`
- Consumes: `POST /score` on `http://localhost:${PORT}/score` (from Task 2)

- [ ] **Step 1: Add `pushScore` helper inside `entry()`**

In `src/agent.ts`, inside the `entry` function, after `const state = ...` and before `await ctx.connect()`, add:

```typescript
const pushScore = (): void => {
  const port = process.env.PORT ?? '3000';
  const words = gameState.fetchList.map(item => ({
    english: item.english,
    translation: item.translation,
    correct: item.correct ?? false,
  }));
  fetch(`http://localhost:${port}/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      score: gameState.score,
      total: gameState.fetchList.length,
      words,
      language: state.targetLanguage,
      timestamp: Date.now(),
    }),
  }).catch(err => console.error('[score] push failed:', err));
};
```

- [ ] **Step 2: Call `pushScore()` in `next_item` when done**

In the `next_item` tool's `execute` function, in the `if (done)` branch, before the `return`:
```typescript
pushScore();
```

The full `if (done)` block becomes:
```typescript
if (done) {
  pushScore();
  return { done: true, score: gameState.score, total: gameState.fetchList.length };
}
```

- [ ] **Step 3: Verify with tsc**

Run: `npx tsc --noEmit`
Expected: zero errors

- [ ] **Step 4: End-to-end smoke test**

Start the full stack with `./start.sh`. Open `http://localhost:3000/scoreboard` in a browser.
FaceTime the Chert line, complete the fetch game.
Expected: score card renders in the browser tab within ~1 second of the agent saying "You got X out of Y".

- [ ] **Step 5: Commit**

```bash
git add src/agent.ts
git commit -m "feat: push score to /score endpoint when fetch game ends

pushScore() fires fire-and-forget on done: true from next_item.
Populates language, score, total, and per-word correctness.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```
