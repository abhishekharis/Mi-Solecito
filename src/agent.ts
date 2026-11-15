import 'dotenv/config';
import { fileURLToPath } from 'url';
import { ServerOptions, cli, defineAgent, JobContext, JobProcess, llm, voice } from '@livekit/agents';
import { realtime } from '@livekit/agents-plugin-google';
import { AgentDispatchClient } from 'livekit-server-sdk';
import { VideoStream, VideoBufferType } from '@livekit/rtc-node';
import sharp from 'sharp';
import type { VideoFrame } from '@livekit/rtc-node';
import { checkObject, identifyObject } from './vision.js';
import {
  createGameState,
  addScannedItem,
  startFetchPhase,
  currentFetchItem,
  advanceFetch,
  resetGame,
  GameState,
} from './game.js';

// ── Dispatch helper (called by webhook server) ────────────────────────────────
export async function dispatchAgent(roomName: string, _callId: string): Promise<void> {
  const client = new AgentDispatchClient(
    process.env.LIVEKIT_URL!,
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
  );
  await client.createDispatch(roomName, 'show-and-say');
}

// ── Frame grabber ─────────────────────────────────────────────────────────────
class FrameGrabber {
  private latestFrame: VideoFrame | null = null;

  feed(frame: VideoFrame) { this.latestFrame = frame; }

  async toJpegBase64(): Promise<string | null> {
    if (!this.latestFrame) return null;
    try {
      const f = this.latestFrame.type !== VideoBufferType.RGBA
        ? this.latestFrame.convert(VideoBufferType.RGBA)
        : this.latestFrame;
      const jpeg = await sharp(Buffer.from(f.data), {
        raw: { width: f.width, height: f.height, channels: 4 },
      }).jpeg({ quality: 75 }).toBuffer();
      return jpeg.toString('base64');
    } catch {
      return null;
    }
  }
}

// ── Tool definitions ──────────────────────────────────────────────────────────
type Args = Record<string, unknown>;

function buildTools(
  grabber: FrameGrabber,
  gameState: GameState,
  state: { targetLanguage: string; consecutiveUnclear: number },
) {
  // Show & Say: identify whatever the learner is holding
  const showAndSay = llm.tool({
    name: 'show_and_say',
    description: "Identify the object in the caller's camera. Call this when the learner shows something in Show & Say mode.",
    parameters: { type: 'object', properties: { language: { type: 'string' } }, required: ['language'] },
    execute: async (args: Args) => {
      const language = args.language as string;
      state.targetLanguage = language;
      const frame = await grabber.toJpegBase64();
      if (!frame) return { success: false, message: 'No frame yet — ask the learner to hold the object steady.' };
      const result = await identifyObject(frame, language);
      if (!result) {
        state.consecutiveUnclear++;
        return { success: false, message: 'Frame unclear. Ask the learner to hold the item closer in better light.' };
      }
      state.consecutiveUnclear = 0;
      return { success: true, english: result.english, translation: result.translation };
    },
  });

  // Scan phase: learner shows an item → agent identifies it → adds to game list
  const addToFetchList = llm.tool({
    name: 'add_to_fetch_list',
    description: 'During the Fetch Game scan phase: identify what the learner is showing and add it to the game list. Returns how many items are in the list so far.',
    parameters: { type: 'object', properties: { language: { type: 'string' } }, required: ['language'] },
    execute: async (args: Args) => {
      const language = args.language as string;
      state.targetLanguage = language;
      const frame = await grabber.toJpegBase64();
      if (!frame) {
        state.consecutiveUnclear++;
        return { success: false, message: 'No frame. Ask the learner to show the item clearly.' };
      }
      const result = await identifyObject(frame, language);
      if (!result) {
        state.consecutiveUnclear++;
        if (state.consecutiveUnclear >= 2) {
          state.consecutiveUnclear = 0;
          return { success: false, skipped: true, message: 'Still unclear — skip this item and ask them to show the next one.' };
        }
        return { success: false, message: 'Frame unclear. Ask the learner to hold the item closer in better light.' };
      }
      state.consecutiveUnclear = 0;
      const count = addScannedItem(gameState, result.english, result.translation);
      return { success: true, english: result.english, translation: result.translation, totalScanned: count };
    },
  });

  // Start the fetch game — either from scanned items or preset fallback
  const startFetchGame = llm.tool({
    name: 'start_fetch_game',
    description: 'Start the Fetch Game. Call this after the scan phase ends (or immediately if skipping scan). Returns the first item to find.',
    execute: async (_args: Args) => {
      const firstItem = startFetchPhase(gameState);
      return {
        started: true,
        totalItems: gameState.fetchList.length,
        firstItem: { english: firstItem.english, translation: firstItem.translation },
      };
    },
  });

  // Check object during fetch game
  const checkObj = llm.tool({
    name: 'check_object',
    description: "Check whether the caller is showing the requested object. Returns match, close, or no_match. Always call before judging.",
    parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    execute: async (args: Args) => {
      const target = args.target as string;
      const frame = await grabber.toJpegBase64();
      if (!frame) {
        state.consecutiveUnclear++;
        return { result: 'unclear', seen: 'no frame yet' };
      }
      const result = await checkObject(target, frame);
      if (result.result === 'unclear' || result.result === 'no_match') {
        state.consecutiveUnclear++;
      } else {
        state.consecutiveUnclear = 0;
      }
      return result;
    },
  });

  // Advance to next item (correct or skip)
  const nextItem = llm.tool({
    name: 'next_item',
    description: 'Advance to the next item in the fetch game after a correct answer or after two failed attempts.',
    parameters: { type: 'object', properties: { wasCorrect: { type: 'boolean' } }, required: ['wasCorrect'] },
    execute: async (args: Args) => {
      const wasCorrect = args.wasCorrect as boolean;
      state.consecutiveUnclear = 0;
      const { item, done } = advanceFetch(gameState, wasCorrect);
      if (done) {
        return { done: true, score: gameState.score, total: gameState.fetchList.length };
      }
      return { done: false, nextItem: { english: item!.english, translation: item!.translation } };
    },
  });

  // Restart the whole game
  const restartGame = llm.tool({
    name: 'restart_game',
    description: 'Reset the game state so the learner can play again. Returns confirmation.',
    execute: async (_args: Args) => {
      resetGame(gameState);
      state.consecutiveUnclear = 0;
      return { restarted: true };
    },
  });

  return [showAndSay, addToFetchList, startFetchGame, checkObj, nextItem, restartGame] as const;
}

// ── Instructions ──────────────────────────────────────────────────────────────

const INSTRUCTIONS = `You are Mi Solecito, a warm and encouraging language-practice tutor for FaceTime calls.

RULES:
- Keep every response to 1-2 short sentences. This is a spoken game, not a lecture.
- Always call the vision tools before naming or judging an object. Never guess from the frame.
- When the frame is unclear, ask the learner to hold the item closer or in better light.
- Ask the learner to repeat words back, but never claim to grade pronunciation.
- Be forgiving, warm, and game-like. Celebrate every correct answer.
- Video frames are never stored; use only what the vision tools return.

LANGUAGE MIXING RULES (critical for beginner learners):
- Speak ENGLISH for all instructions, questions, hints, and explanations.
- Speak the TARGET LANGUAGE only for: (1) the vocabulary word with its article (e.g. "la taza"), and (2) two fixed celebration/correction words: "¡Muy bien!" for correct, "¡Casi!" for close.
- In show-and-say: say the English name first, then the target-language word with article. Example: "That's a cup — in Spanish, la taza. Can you say la taza?"
- In the fetch game: ask for the item in English ("Can you find a cup?"), then give the word: "In Spanish that's la taza." After they show it, say "¡Muy bien! That's la taza."
- Never produce a full sentence in the target language. Never translate your instructions.

CALL START SEQUENCE (do this in order, all in one turn):
1. Say this EXACT line: "Hi! Just so you know, this call uses your camera for language practice — no video is stored. Which language would you like to practice? For example, Spanish, French, or Japanese."
2. After they name a language, ask in ONE sentence: "Great! Do you want Show and Say — where you show me things and I name them — or the Fetch Game, where I ask you to find things?"
3. Begin the chosen activity immediately.

SHOW AND SAY MODE:
- Tell the learner: "Hold up any object and say 'go' or 'ready' when you're holding it — I'll name it for you."
- When they say go/ready (or any word signalling they're holding something up), call show_and_say with the chosen language immediately.
- Say the English name, then the target-language word with article.
- Ask them to repeat it, then say "Show me another one whenever you're ready!"
- Repeat for each new object they show.
- If the learner says "quit" or "stop", ask if they want to try the Fetch Game or end the call.

FETCH GAME — SCAN PHASE:
- Tell the learner: "Great! Before we play, hold up 5 things near you one at a time — I'll remember what you have."
- Tell the learner: "Hold up an item and say 'go' when you're holding it." When they say go (or any word indicating they're ready), call add_to_fetch_list. Confirm each one out loud: "Got it, a cup — show me the next one!"
- After 5 items (or more if they want), say: "Perfect, I've got your items. Let's play!"
- Call start_fetch_game to begin. Use the returned firstItem as the first challenge.
- If you can't scan enough items (< 3), call start_fetch_game anyway — it will use a preset list.

FETCH GAME — PLAY PHASE:
- Ask for each item in English, then give the target-language word: "Can you find the cup? In Spanish that's la taza."
- Tell the learner to say "here" or "got it" when they're holding the item up. When they do, call check_object with the English target.
- On "match": say "¡Muy bien! That's la taza." then call next_item with wasCorrect: true.
- On "close": say "¡Casi! That looks like it — maybe hold it a bit closer?" and try again.
- On "no_match" or "unclear" twice in a row: say "No worries, let's skip that one." Call next_item with wasCorrect: false.
- Do not give the consecutive-unclear count out loud — just skip naturally after two attempts.

END OF GAME:
- When next_item returns done: true, say: "You got [score] out of [total] — great work!"
- Then ask: "Want to play again, switch to Show and Say, or end the call?"
- If they want to play again: call restart_game, then run the scan phase again.
- If they want Show and Say: call restart_game to clear state, then switch to Show and Say mode.

QUIT AT ANY TIME:
- If the learner says "quit", "stop", "done", or "end": wrap up warmly and offer to play again or end the call.
- If they want to end: say "Great practice! Goodbye!" and let the call close naturally.`;

// ── Agent definition ──────────────────────────────────────────────────────────

export default defineAgent({
  prewarm: async (_proc: JobProcess) => { /* nothing to prewarm */ },

  entry: async (ctx: JobContext) => {
    try {
      const grabber = new FrameGrabber();
      const gameState: GameState = createGameState();
      const state = { targetLanguage: 'Spanish', consecutiveUnclear: 0 };

      await ctx.connect();

      ctx.room.on('trackSubscribed', (track: any) => {
        if (track.kind === 'video') {
          const stream = new VideoStream(track);
          (async () => {
            for await (const event of stream) {
              grabber.feed(event.frame);
            }
          })().catch(() => {});
        }
      });

      await ctx.waitForParticipant();

      const tools = buildTools(grabber, gameState, state);

      const model = new realtime.RealtimeModel({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        apiKey: process.env.GEMINI_API_KEY,
        voice: 'Puck',
      });

      class MiSolecitoAgent extends voice.Agent {
        override async onEnter(): Promise<void> {
          this.session.generateReply();
        }
      }

      const agent = new MiSolecitoAgent({
        instructions: INSTRUCTIONS,
        llm: model,
        tools: [...tools],
      });

      const session = new voice.AgentSession();
      await session.start({ agent, room: ctx.room });
    } catch (err) {
      console.error('[mi-solecito] entry function crashed:', err);
      throw err;
    }
  },
});

// ── Entry point ───────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(
    new ServerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: 'show-and-say',
    }),
  );
}
