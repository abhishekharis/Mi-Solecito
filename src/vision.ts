import OpenAI from 'openai';

let _openai: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

export type VisionResult = 'match' | 'close' | 'no_match' | 'unclear';

export interface CheckObjectResult {
  result: VisionResult;
  seen: string;
  confidence: 'high' | 'low';
}

export async function checkObject(target: string, frameData: string): Promise<CheckObjectResult> {
  const prompt = `You are checking a video frame from a language-learning FaceTime call.
Target object: "${target}"

Rules:
- Focus ONLY on physical objects — ignore people, hands, and body parts.
- "match": the target object is clearly visible.
- "close": a similar or related object is visible (e.g. fork when spoon was asked).
- "no_match": something else entirely is visible (do not count a person as a match).
- "unclear": the frame is too dark, blurry, or empty to judge.
- Keep "seen" to 3-5 words describing the object, never the person.`;

  try {
    const response = await (getClient() as any).responses.create({
      model: 'gpt-6.1-terra',
      reasoning: { effort: 'low' },
      store: false,
      max_output_tokens: 60,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          { type: 'input_image', image_url: `data:image/jpeg;base64,${frameData}`, detail: 'high' },
        ],
      }],
      text: {
        format: {
          type: 'json_schema',
          name: 'check_result',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              result: { type: 'string', enum: ['match', 'close', 'no_match', 'unclear'] },
              seen: { type: 'string' },
              confidence: { type: 'string', enum: ['high', 'low'] },
            },
            required: ['result', 'seen', 'confidence'],
            additionalProperties: false,
          },
        },
      },
    });
    return JSON.parse(response.output_text) as CheckObjectResult;
  } catch {
    return { result: 'unclear', seen: 'could not process frame', confidence: 'low' };
  }
}

export async function identifyObject(
  frameData: string,
  targetLanguage: string,
  alreadyScanned: string[] = [],
): Promise<{ english: string; translation: string } | null> {
  const context = alreadyScanned.length > 0
    ? `\nAlready scanned (skip these): ${alreadyScanned.join(', ')}.`
    : '';
  const prompt = `You are a language tutor. Identify the most prominent physical OBJECT being held or displayed.
Ignore people, hands, and body parts entirely.
If the most visible thing is a person with no clear object, or the frame is unclear, return empty strings.
Provide the object name in English and its translation in ${targetLanguage} with article if applicable.${context}`;

  try {
    const response = await (getClient() as any).responses.create({
      model: 'gpt-6.1-terra',
      reasoning: { effort: 'low' },
      store: false,
      max_output_tokens: 60,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          { type: 'input_image', image_url: `data:image/jpeg;base64,${frameData}`, detail: 'high' },
        ],
      }],
      text: {
        format: {
          type: 'json_schema',
          name: 'identify_result',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              english: { type: 'string' },
              translation: { type: 'string' },
              confidence: { type: 'string', enum: ['high', 'low'] },
            },
            required: ['english', 'translation', 'confidence'],
            additionalProperties: false,
          },
        },
      },
    });
    const parsed = JSON.parse(response.output_text) as {
      english: string;
      translation: string;
      confidence: string;
    };
    return parsed.english ? { english: parsed.english, translation: parsed.translation } : null;
  } catch {
    return null;
  }
}
