import 'dotenv/config';
import { fileURLToPath } from 'url';
import { ServerOptions, cli, defineAgent, JobContext, JobProcess, llm, voice } from '@livekit/agents';
import { LLM } from '@livekit/agents-plugin-google';
import { TTS } from '@livekit/agents-plugin-elevenlabs';
import { STT } from '@livekit/agents-plugin-deepgram';
import { AgentDispatchClient } from 'livekit-server-sdk';
import { VideoStream, VideoBufferType, TrackKind, RoomEvent } from '@livekit/rtc-node';
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
  private frameCount = 0;

  feed(frame: VideoFrame) {
    this.frameCount++;
    if (this.frameCount === 1) {
      console.log(`[vision] first frame received — ${frame.width}x${frame.height} type=${frame.type}`);
    }
    this.latestFrame = frame;
  }

  async toJpegBase64(): Promise<string | null> {
    if (!this.latestFrame) {
      console.log('[vision] toJpegBase64 called but no frame captured yet');
      return null;
    }
    try {
      const f = this.latestFrame.type !== VideoBufferType.RGBA
        ? this.latestFrame.convert(VideoBufferType.RGBA)
        : this.latestFrame;
      const jpeg = await sharp(Buffer.from(f.data), {
        raw: { width: f.width, height: f.height, channels: 4 },
      }).jpeg({ quality: 75 }).toBuffer();
      console.log(`[vision] JPEG encoded — ${jpeg.length} bytes from ${f.width}x${f.height}`);
      return jpeg.toString('base64');
    } catch (err) {
      console.error('[vision] toJpegBase64 error:', err);
      return null;
    }
  }
}

// ── Tool definitions ──────────────────────────────────────────────────────────
type Args = Record<string, unknown>;

function buildTools(
  grabber: FrameGrabber,
  gameState: GameState,
  state: { targetLanguage: string; consecutiveUnclear: number; lastAnnounced: string },
) {
  // Fire-and-forget: push the final score to the companion score card page
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

  // Show & Say: identify whatever the learner is holding
  const showAndSay = llm.tool({
    name: 'show_and_say',
    description: "Identify the object in the caller's camera. Call this ONLY in Show & Say mode — never during the fetch game.",
    parameters: { type: 'object', properties: { language: { type: 'string' } }, required: ['language'] },
    execute: async (args: Args) => {
      if (gameState.phase === 'fetching') {
        return { success: false, message: 'Wrong mode — use check_object during the fetch game, not show_and_say.' };
      }
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
    description: 'During the Fetch Game SCAN PHASE only: identify what the learner is showing and add it to the game list. Never call during fetch play phase. Returns how many items are in the list so far.',
    parameters: { type: 'object', properties: { language: { type: 'string' } }, required: ['language'] },
    execute: async (args: Args) => {
      if (gameState.phase === 'fetching' || gameState.phase === 'done') {
        return { success: false, message: 'Wrong phase — scan phase is over. Use check_object to verify items during fetch play.' };
      }
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
    description: 'Start the Fetch Game. Call this ONLY after the learner has shown items during the scan phase (at least 5, or when they say they are done). Never call this immediately when the learner chooses Fetch Game — always scan first.',
    execute: async (_args: Args) => {
      if (gameState.phase !== 'scanning') {
        return { error: true, message: 'You must scan items first. Tell the learner to hold up objects one at a time before starting the game.' };
      }
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
    description: "Check whether the caller is showing the requested object during FETCH PLAY. Returns match, close, or no_match. Always call before judging.",
    parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    execute: async (args: Args) => {
      if (gameState.phase !== 'fetching') {
        return { result: 'error', message: 'Wrong phase — check_object is only for the fetch play phase.' };
      }
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
      if (gameState.phase !== 'fetching') {
        return { error: true, message: 'Wrong phase — next_item is only for the fetch play phase.' };
      }
      const wasCorrect = args.wasCorrect as boolean;
      state.consecutiveUnclear = 0;
      const { item, done } = advanceFetch(gameState, wasCorrect);
      if (done) {
        pushScore();
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
      state.lastAnnounced = '';
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
- In the fetch game: ask for the item using ONLY the target-language word: "Can you find la taza?" — no English. After they show it, say "¡Muy bien! That's la taza."
- Never produce a full sentence in the target language. Never translate your instructions.

CALL START SEQUENCE (do this in order, all in one turn):
1. Pick ONE of the following opening lines — vary which you use each call, never repeat the same one twice in a row:
   - "Hey! Ready to learn some words? I'll look at real objects near you and name them in another language — no video stored. Which language are we trying?"
   - "Hi! I'm Mi Solecito — I teach vocabulary using real objects around you. I use your camera for that, but nothing's ever stored. Which language are we learning today?"
   - "Hello! Point your camera at anything around you and I'll teach you its name in another language — no video saved. What language today?"
2. After they name a language, explain the two modes in ONE sentence — pick one of these, varying each call:
   - "Nice! Two ways to play: Show & Say — hold up any object and I name it — or Fetch Game, where I scan 5 things near you then quiz you to find each one using only its [language] name. Which sounds fun?"
   - "Great! You can do Show & Say — show me objects and I name them — or Fetch Game, where I learn 5 items you have nearby then challenge you to retrieve each one by its [language] name. Which one?"
   - "Perfect! Show & Say: you hold things up and I name them. Fetch Game: I scan 5 items in your room and quiz you to find each one by its [language] name only. What do you feel like?"
   Replace [language] with the language they named.
3. Begin the chosen activity immediately.

SHOW AND SAY MODE:
- Tell the learner: "Hold up any object — I'll detect it automatically and name it for you. If I miss one, just say anything and I'll try again."
- When they say any word while holding an object, call show_and_say with the chosen language immediately (this is the verbal fallback).
- Say the English name, then the target-language word with article.
- Ask them to repeat it, then say "Show me another one whenever you're ready!"
- Repeat for each new object they show.
- If the learner says "quit" or "stop", ask if they want to try the Fetch Game or end the call.

FETCH GAME — SCAN PHASE:
- Tell the learner: "Great! Before we play, hold up 5 things near you one at a time — I'll remember what you have."
- Tell the learner: "Hold up items one at a time — I'll detect each one automatically. If I miss one, just say anything and I'll scan it." When they say any word while holding an item, call add_to_fetch_list as a fallback. The vision loop handles auto-detection; confirm each item out loud: "Got it, a cup — show me the next one!"
- After 5 items (or more if they want), say: "Perfect, I've got your items. Let's play!"
- Call start_fetch_game to begin. Use the returned firstItem as the first challenge.
- Do NOT call start_fetch_game until the learner has actually shown objects. If items keep failing to scan after several attempts, ask the learner to try different objects in better light.

FETCH GAME — PLAY PHASE:
- Ask for each item using ONLY the target-language word — never say the English word during the fetch challenge. Example: "Can you find la taza?" NOT "Can you find the cup?" The learner must make the connection themselves.
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
  prewarm: async (proc: JobProcess) => {
    // Initialize plugins here so entry() doesn't block the event loop on first call
    proc.userData.stt = new STT({ apiKey: process.env.DEEPGRAM_API_KEY });
    proc.userData.llm = new LLM({ model: 'gemini-3.5-flash-lite', apiKey: process.env.GEMINI_API_KEY });
    proc.userData.tts = new TTS({ apiKey: process.env.ELEVENLABS_API_KEY });
  },

  entry: async (ctx: JobContext) => {
    try {
      const { stt, llm, tts } = ctx.proc.userData as {
        stt: STT; llm: LLM; tts: TTS;
      };
      const grabber = new FrameGrabber();
      const gameState: GameState = createGameState();
      const state = { targetLanguage: 'Spanish', consecutiveUnclear: 0, lastAnnounced: '' };

      await ctx.connect();

      const startVideoStream = (track: any) => {
        console.log(`[vision] attaching VideoStream — kind=${track.kind} sid=${track.sid}`);
        const stream = new VideoStream(track);
        (async () => {
          for await (const event of stream) {
            grabber.feed(event.frame);
          }
        })().catch(err => console.error('[vision] VideoStream error:', err));
      };

      // kind is a numeric enum: TrackKind.KIND_VIDEO === 2 (not the string 'video')
      ctx.room.on(RoomEvent.TrackSubscribed, (track: any) => {
        console.log(`[vision] trackSubscribed event — kind=${track.kind}`);
        if (track.kind === TrackKind.KIND_VIDEO) startVideoStream(track);
      });

      await ctx.waitForParticipant();

      // Catch tracks already subscribed before the listener was registered
      for (const participant of ctx.room.remoteParticipants.values()) {
        for (const pub of (participant as any).trackPublications.values()) {
          const t = (pub as any).track;
          if (t && t.kind === TrackKind.KIND_VIDEO) {
            console.log('[vision] found already-subscribed video track');
            startVideoStream(t);
          }
        }
      }

      const tools = buildTools(grabber, gameState, state);

      class MiSolecitoAgent extends voice.Agent {
        override async onEnter(): Promise<void> {
          this.session.generateReply();
        }
      }

      const agent = new MiSolecitoAgent({
        instructions: INSTRUCTIONS,
        stt,
        llm,
        tts,
        tools: [...tools],
      });

      const session = new voice.AgentSession();
      await session.start({ agent, room: ctx.room });

      // ── Background vision polling loop ────────────────────────────────────────
      // Fires every 2500ms during Show & Say (idle) and scan phases.
      // Calls session.say() directly — no LLM needed to name an object.
      // Verbal trigger path (LLM tools) stays intact as fallback.
      (async () => {
        while (true) {
          await new Promise(r => setTimeout(r, 1500));
          if (gameState.phase !== 'scanning' || !state.targetLanguage) continue;
          const frame = await grabber.toJpegBase64();
          if (!frame) continue;
          const result = await identifyObject(frame, state.targetLanguage).catch(() => null);
          if (!result?.english) continue;
          // Re-check phase after async identifyObject — phase may have changed to 'fetching'
          if (gameState.phase !== 'scanning') continue;
          if (result.english.toLowerCase() === state.lastAnnounced.toLowerCase()) continue;
          state.lastAnnounced = result.english;
          const word = result.translation ?? result.english;
          addScannedItem(gameState, result.english, word);
          await session.say(`Got it — ${result.english}, that's ${word}! Show me the next one.`);
        }
      })().catch(err => console.error('[vision-loop] crashed:', err));

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
