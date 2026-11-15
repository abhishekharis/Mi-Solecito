# Mi Solecito

A FaceTime language-learning tutor that uses your camera to teach vocabulary. Call it on FaceTime, pick a language, and play one of two games — Show & Say or the Fetch Game — powered by Gemini Live voice and Gemini Flash vision.

## How it works

Mi Solecito runs as a LiveKit voice agent and receives FaceTime calls through [Chert](https://trychert.com). Every call is routed to the agent, which speaks using Google's Gemini Live 2.5 realtime model and sees your camera via Gemini Flash vision.

```
FaceTime call → Chert bridge → LiveKit room → Gemini Live (voice) + Gemini Flash (vision)
```

### Games

**Show & Say** — Hold up any object. The agent identifies it and tells you the word in your chosen language, with the article (e.g. *la taza* for cup in Spanish). Say it back to practice.

**Fetch Game** — Before the game starts, hold up 5–8 things near you. The agent builds the game from exactly those items, so every word is guaranteed to be in the room. Then it asks you to find each one by name. No skipping needed.

Both modes keep all instructions and conversation in English. The target language appears only for the vocabulary word, its article, and two celebration words: *¡Muy bien!* and *¡Casi!*

## Stack

| Layer | Technology |
|---|---|
| FaceTime routing | [Chert](https://trychert.com) (`@trychert/facetime`) |
| Voice agent framework | LiveKit Agents (`@livekit/agents`) |
| Voice LLM | Gemini Live 2.5 (`gemini-2.5-flash-native-audio-preview-12-2025`) |
| Vision | Gemini Flash (`gemini-1.5-flash` via `@google/generative-ai`) |
| Video frame capture | `@livekit/rtc-node` `VideoStream` + `sharp` for JPEG encoding |
| Server | Hono on Node.js (production webhook mode) |

## Setup

### Prerequisites

- Node.js 18+
- A [Chert](https://trychert.com) account with a trial FaceTime line
- A [LiveKit Cloud](https://cloud.livekit.io) project
- A [Google AI Studio](https://aistudio.google.com) Gemini API key

### Install

```bash
git clone https://github.com/abhishekharis/Mi-Solecito.git
cd Mi-Solecito
npm install
```

### Configure

Copy the example env file and fill in your keys:

```bash
cp .env.local.example .env
```

```
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your_api_key
LIVEKIT_API_SECRET=your_api_secret
GEMINI_API_KEY=your_gemini_key
```

Sign in to Chert (one-time):

```bash
npx @trychert/facetime setup
```

### Run (development)

Build and start the agent worker:

```bash
npm run build
npm run agent
```

In a second terminal, start Chert to route FaceTime calls to the agent:

```bash
npx @trychert/facetime@0.1.0-beta.21 dev --agent show-and-say --env-file .env
```

Then FaceTime the number Chert assigned to your line. The agent picks up, asks which language you want to practice, and starts the game.

## Project structure

```
src/
  agent.ts    — LiveKit agent definition, tools, session entry point
  vision.ts   — Gemini Flash vision tools (identify object, check object)
  game.ts     — Fetch game state and word list
  server.ts   — Hono webhook server (production mode)
scripts/
  setup-env.mjs  — Helper to populate .env from Chert LiveKit credentials
```

## Scripts

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run agent` | Start the LiveKit agent worker (runs `dist/agent.js`) |
| `npm run server` | Start the webhook server (production mode) |

## Privacy

The agent states on every call that no video is stored. Video frames are passed directly to the Gemini API for real-time analysis and are never written to disk or any database.
