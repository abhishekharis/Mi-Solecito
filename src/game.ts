// In-memory game state per call — resets each call, no database.

export interface WordEntry {
  word: string;
  hint: string;
  category: 'home' | 'food' | 'clothing';
}

export interface FetchItem {
  english: string;
  translation: string | null; // null = agent uses its own LLM knowledge
  hint: string | null;
}

export interface GameState {
  phase: 'idle' | 'scanning' | 'fetching' | 'done';
  fetchList: FetchItem[];
  currentIndex: number;
  score: number;
}

// ── Word pool: 30 words across 3 categories ──────────────────────────────────

export const WORD_POOL: WordEntry[] = [
  // Home
  { word: 'cup',     hint: 'something you drink from',           category: 'home'     },
  { word: 'book',    hint: 'something you read',                 category: 'home'     },
  { word: 'lamp',    hint: 'something that gives light',         category: 'home'     },
  { word: 'clock',   hint: 'something that shows the time',      category: 'home'     },
  { word: 'pen',     hint: 'something you write with',           category: 'home'     },
  { word: 'key',     hint: 'something that opens a door',        category: 'home'     },
  { word: 'bag',     hint: 'something you carry things in',      category: 'home'     },
  { word: 'pillow',  hint: 'something you sleep on',             category: 'home'     },
  { word: 'chair',   hint: 'something you sit on',               category: 'home'     },
  { word: 'bottle',  hint: 'something that holds liquid',        category: 'home'     },
  // Food
  { word: 'apple',   hint: 'a round red or green fruit',         category: 'food'     },
  { word: 'banana',  hint: 'a yellow curved fruit',              category: 'food'     },
  { word: 'bread',   hint: 'something you make toast with',      category: 'food'     },
  { word: 'egg',     hint: 'something oval that comes from a chicken', category: 'food' },
  { word: 'spoon',   hint: 'something you eat soup with',        category: 'food'     },
  { word: 'fork',    hint: 'something you eat pasta with',       category: 'food'     },
  { word: 'plate',   hint: 'something flat you eat off',         category: 'food'     },
  { word: 'glass',   hint: 'something you drink water from',     category: 'food'     },
  { word: 'bowl',    hint: 'something round you eat cereal from',category: 'food'     },
  { word: 'orange',  hint: 'a round orange fruit',               category: 'food'     },
  // Clothing
  { word: 'shirt',   hint: 'something you wear on your top',     category: 'clothing' },
  { word: 'sock',    hint: 'something you wear on your foot',    category: 'clothing' },
  { word: 'hat',     hint: 'something you wear on your head',    category: 'clothing' },
  { word: 'jacket',  hint: 'something you wear when it is cold', category: 'clothing' },
  { word: 'belt',    hint: 'something that holds up trousers',   category: 'clothing' },
  { word: 'scarf',   hint: 'something you wrap around your neck',category: 'clothing' },
  { word: 'glove',   hint: 'something you wear on your hand',    category: 'clothing' },
  { word: 'shoe',    hint: 'something you wear on your foot',    category: 'clothing' },
  { word: 'watch',   hint: 'something on your wrist that tells the time', category: 'clothing' },
  { word: 'ring',    hint: 'something you wear on your finger',  category: 'clothing' },
];

function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5);
}

export function pickPresetItems(n: number): FetchItem[] {
  return shuffle(WORD_POOL).slice(0, n).map(w => ({
    english: w.word,
    translation: null,
    hint: w.hint,
  }));
}

// ── Game state lifecycle ──────────────────────────────────────────────────────

export function createGameState(): GameState {
  return { phase: 'idle', fetchList: [], currentIndex: 0, score: 0 };
}

export function resetGame(state: GameState): void {
  state.phase = 'idle';
  state.fetchList = [];
  state.currentIndex = 0;
  state.score = 0;
}

// ── Scan phase ────────────────────────────────────────────────────────────────

export function addScannedItem(state: GameState, english: string, translation: string): number {
  if (state.phase === 'idle') state.phase = 'scanning';
  const normalised = english.toLowerCase().trim();
  if (!state.fetchList.some(i => i.english.toLowerCase() === normalised)) {
    state.fetchList.push({ english: english.trim(), translation, hint: null });
  }
  return state.fetchList.length;
}

// ── Fetch phase ───────────────────────────────────────────────────────────────

export function startFetchPhase(state: GameState): FetchItem {
  if (state.fetchList.length < 3) {
    // Not enough scanned items — fall back to preset random words
    state.fetchList = pickPresetItems(8);
  } else {
    // Shuffle the scanned list so the order is unpredictable
    state.fetchList = shuffle(state.fetchList);
  }
  state.phase = 'fetching';
  state.currentIndex = 0;
  return state.fetchList[0]!;
}

export function currentFetchItem(state: GameState): FetchItem | null {
  return state.fetchList[state.currentIndex] ?? null;
}

export function advanceFetch(
  state: GameState,
  wasCorrect: boolean,
): { item: FetchItem | null; done: boolean } {
  if (wasCorrect) state.score++;
  state.currentIndex++;
  if (state.currentIndex >= state.fetchList.length) {
    state.phase = 'done';
    return { item: null, done: true };
  }
  return { item: state.fetchList[state.currentIndex]!, done: false };
}
