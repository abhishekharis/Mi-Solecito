import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

export type VisionResult = 'match' | 'close' | 'no_match' | 'unclear';

export interface CheckObjectResult {
  result: VisionResult;
  seen: string; // what the model actually saw
  confidence: 'high' | 'low';
}

/**
 * Check whether the latest video frame shows the target object.
 * frameData: base64-encoded JPEG.
 */
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

  const imagePart = {
    inlineData: { data: frameData, mimeType: 'image/jpeg' as const },
  };

  try {
    const response = await model.generateContent([prompt, imagePart]);
    const text = response.response.text().trim();
    // Strip markdown code fences if present
    const json = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(json) as CheckObjectResult;
  } catch {
    return { result: 'unclear', seen: 'could not process frame', confidence: 'low' };
  }
}

/**
 * Identify what object is in the frame (for show-and-say mode).
 * Returns the object name in English plus the target language translation.
 */
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

  const imagePart = {
    inlineData: { data: frameData, mimeType: 'image/jpeg' as const },
  };

  try {
    const response = await model.generateContent([prompt, imagePart]);
    const text = response.response.text().trim();
    const json = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(json) as { english: string; translation: string };
    return parsed.english ? parsed : null;
  } catch {
    return null;
  }
}
