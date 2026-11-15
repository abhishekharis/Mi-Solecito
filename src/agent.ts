import 'dotenv/config';
import { fileURLToPath } from 'url';
import { ServerOptions, cli, defineAgent, JobContext, JobProcess, llm, voice } from '@livekit/agents';
import { realtime } from '@livekit/agents-plugin-google';
import { AgentDispatchClient } from 'livekit-server-sdk';
import { VideoStream, VideoBufferType } from '@livekit/rtc-node';
import sharp from 'sharp';
import { checkObject, identifyObject } from './vision.js';
import { createGameState, currentItem, advanceItem, GameState } from './game.js';

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
import type { VideoFrame } from '@livekit/rtc-node';

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

// Raw JSON schema args come in as JSONObject; we cast the values we need.
type Args = Record<string, unknown>;

function buildTools(grabber: FrameGrabber, gameState: GameState, state: { targetLanguage: string }) {
  const showAndSay = llm.tool({
    name: 'show_and_say',
    description: "Identify the object in the caller's camera. Call this when the learner shows something.",
    parameters: { type: 'object', properties: { language: { type: 'string' } }, required: ['language'] },
    execute: async (args: Args) => {
      const language = args.language as string;
      state.targetLanguage = language;
      const frame = await grabber.toJpegBase64();
      if (!frame) return { success: false, message: 'No video frame yet. Ask the learner to hold the object steady.' };
      const result = await identifyObject(frame, language);
      if (!result) return { success: false, message: 'Frame unclear. Ask the learner to hold the object closer and in better light.' };
      return { success: true, english: result.english, translation: result.translation };
    },
  });

  const checkObj = llm.tool({
    name: 'check_object',
    description: 'Check whether the caller is showing the requested object. Returns match, close, or no_match. Always call before judging an object.',
    parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    execute: async (args: Args) => {
      const target = args.target as string;
      const frame = await grabber.toJpegBase64();
      if (!frame) return { result: 'unclear', seen: 'no frame yet' };
      return checkObject(target, frame);
    },
  });

  const nextItem = llm.tool({
    name: 'next_item',
    description: 'Advance to the next item in the fetch game after a correct answer or two failed attempts.',
    parameters: { type: 'object', properties: { wasCorrect: { type: 'boolean' } }, required: ['wasCorrect'] },
    execute: async (args: Args) => {
      const wasCorrect = args.wasCorrect as boolean;
      const { item, done } = advanceItem(gameState, wasCorrect);
      if (done) return { done: true, score: gameState.score, total: 8 };
      return { done: false, nextItem: item };
    },
  });

  const startFetchGame = llm.tool({
    name: 'start_fetch_game',
    description: 'Start the fetch game and return the first item.',
    execute: async (_args: Args) => {
      const item = currentItem(gameState);
      return { started: true, firstItem: item };
    },
  });

  return [showAndSay, checkObj, nextItem, startFetchGame] as const;
}

// ── Agent definition ──────────────────────────────────────────────────────────

const INSTRUCTIONS = `You are Show & Say, a warm and encouraging language-practice tutor for FaceTime calls.

RULES:
- Keep every response to 1-2 short sentences. This is a spoken game, not a lecture.
- Always call the vision tools before naming or judging an object. Never guess.
- When the frame is unclear, ask the learner to hold the item closer or in better light.
- Ask the learner to repeat words back, but never claim to grade pronunciation.
- Be forgiving, warm, and game-like. Celebrate every correct answer.
- Video frames are never stored; use only what the vision tools return.
- If the learner says they don't have an object nearby, call next_item with wasCorrect: false to skip it.

LANGUAGE MIXING RULES (critical for beginner learners):
- Speak ENGLISH for all instructions, questions, hints, and explanations.
- Speak the TARGET LANGUAGE only for: (1) the vocabulary word with its article (e.g. "la taza"), and (2) two fixed celebration/correction words: "¡Muy bien!" for correct, "¡Casi!" for close.
- In show-and-say: say the English name first, then the target-language word with article. Example: "That's a cup — in Spanish, la taza. Can you say la taza?"
- In the fetch game: ask for the item in English ("Can you find a cup?"), then give the word: "In Spanish that's la taza." After they show it, say "¡Muy bien! That's la taza."
- Never produce a full sentence in the target language. Never translate your instructions.

CALL START SEQUENCE (do this in order, all in one turn):
1. Say this EXACT line: "Hi! Just so you know, this call uses your camera for language practice — no video is stored. Which language would you like to practice? For example, Spanish, French, or Japanese."
2. After they name a language, ask in ONE sentence: "Great! Do you want Show and Say — where you show me things and I name them — or the Fetch Game, where I ask you to find things?"
3. Begin the chosen activity immediately.`;

export default defineAgent({
  prewarm: async (_proc: JobProcess) => { /* nothing to prewarm */ },

  entry: async (ctx: JobContext) => {
    try {
      const grabber = new FrameGrabber();
      const gameState: GameState = createGameState();
      const state = { targetLanguage: 'Spanish' };

      await ctx.connect();

      // Wire video track using VideoStream — the correct rtc-node API for frame capture
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

      class ShowAndSayAgent extends voice.Agent {
        override async onEnter(): Promise<void> {
          // Trigger Gemini to speak the opening greeting immediately.
          this.session.generateReply();
        }
      }

      const agent = new ShowAndSayAgent({
        instructions: INSTRUCTIONS,
        llm: model,
        tools: [...tools],
      });

      const session = new voice.AgentSession();
      await session.start({ agent, room: ctx.room });
      // Entry returns here; the framework keeps the job alive until the call ends.
    } catch (err) {
      console.error('[show-and-say] entry function crashed:', err);
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
