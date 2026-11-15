// In-memory game state per call — resets each call, no database.

export const WORD_LIST = [
  { word: 'cup',    hint: 'something you drink from' },
  { word: 'book',   hint: 'something you read' },
  { word: 'shoe',   hint: 'something you wear on your foot' },
  { word: 'spoon',  hint: 'something you eat soup with' },
  { word: 'pen',    hint: 'something you write with' },
  { word: 'phone',  hint: 'something you talk on' },
  { word: 'key',    hint: 'something that opens a door' },
  { word: 'bottle', hint: 'something that holds water' },
];

export interface GameState {
  currentIndex: number;
  score: number;
  done: boolean;
}

export function createGameState(): GameState {
  return { currentIndex: 0, score: 0, done: false };
}

export function currentItem(state: GameState) {
  return WORD_LIST[state.currentIndex] ?? null;
}

export function advanceItem(state: GameState, wasCorrect: boolean): { item: (typeof WORD_LIST)[0] | null; done: boolean } {
  if (wasCorrect) state.score++;
  state.currentIndex++;
  if (state.currentIndex >= WORD_LIST.length) {
    state.done = true;
    return { item: null, done: true };
  }
  return { item: WORD_LIST[state.currentIndex], done: false };
}
