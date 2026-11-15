import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type VisionResult = 'match' | 'close' | 'no_match' | 'unclear';

export interface CheckObjectResult {
  result: VisionResult;
  seen: string;
  confidence: 'high' | 'low';
}

export async function checkObject(target: string, frameData: string): Promise<CheckObjectResult> {
  const prompt = `You are checking a video frame from a language-learning FaceTime call.
Target object: "${target}"

Look at the image and answer ONLY with valid JSON in this exact shape:
{
  "result": "match" | "close" | "no_match" | "unclear",
  "seen": "<one short phrase describing the object you see, or 'nothing clear' if the frame is dark/blurry>",
  "confidence": "high" | "low"
}

Rules:
- Focus ONLY on physical objects — ignore any people, hands, or body parts in the frame.
- "match": the target object is clearly visible.
- "close": a similar or related object is visible (e.g. fork when spoon was asked).
- "no_match": something else entirely is visible (do not count a person as a match).
- "unclear": the frame is too dark, blurry, or empty to judge.
- Keep "seen" to 3-5 words describing the object, never the person.
- Output ONLY the JSON object, no extra text.`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-6.1-terra',
      reasoning_effort: 'none',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${frameData}` } },
        ],
      }],
    });
    const text = (response.choices[0].message.content ?? '').trim();
    const json = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(json) as CheckObjectResult;
  } catch {
    return { result: 'unclear', seen: 'could not process frame', confidence: 'low' };
  }
}

export async function identifyObject(frameData: string, targetLanguage: string): Promise<{ english: string; translation: string } | null> {
  const prompt = `You are a language tutor. Look at this image and identify the most prominent OBJECT being held or displayed.
Respond ONLY with valid JSON:
{
  "english": "<object name in English, 1-3 words>",
  "translation": "<translation in ${targetLanguage} with article if applicable>"
}

Rules:
- Identify the physical object, NOT the person holding it. Ignore people, hands, and body parts entirely.
- If the most visible thing is a person with no clear object, respond with: {"english": "", "translation": ""}
- If the frame is unclear or empty, respond with: {"english": "", "translation": ""}
- Output ONLY the JSON object, no extra text.`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-6.1-terra',
      reasoning_effort: 'none',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${frameData}` } },
        ],
      }],
    });
    const text = (response.choices[0].message.content ?? '').trim();
    const json = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(json) as { english: string; translation: string };
    return parsed.english ? parsed : null;
  } catch {
    return null;
  }
}
