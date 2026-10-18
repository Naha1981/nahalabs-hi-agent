// Voice turns: audio in -> transcript -> the shared agent -> spoken answer out.
// STT and TTS run through the existing Groq account (whisper-large-v3-turbo and
// canopylabs/orpheus-v1-english, both free tier). Providers stay behind these two
// functions so they can be swapped (self-hosted faster-whisper / Kokoro) without
// touching the agent or the channels.
export function voiceConfigured() {
  return !!process.env.GROQ_API_KEY && process.env.VOICE_ENABLED !== 'false';
}
export const voiceMaxBytes = () => Number(process.env.VOICE_MAX_BYTES || 6 * 1024 * 1024);
const sttModel = () => process.env.VOICE_STT_MODEL || 'whisper-large-v3-turbo';
const ttsModel = () => process.env.VOICE_TTS_MODEL || 'canopylabs/orpheus-v1-english';
const ttsVoice = () => process.env.VOICE_TTS_VOICE || 'austin';

const MIME_EXT = { 'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac' };

export async function transcribe({ bytes, mime, fetchImpl = fetch }) {
  const base = String(mime || 'audio/webm').split(';')[0].toLowerCase();
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: base }), 'turn.' + (MIME_EXT[base] || 'webm'));
  form.append('model', sttModel());
  form.append('language', 'en');
  form.append('response_format', 'json');
  const res = await fetchImpl('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error('speech-to-text failed (' + res.status + ')');
  const j = await res.json();
  return String(j.text || '').trim().slice(0, 2000);
}

// Returns a Buffer of wav audio, or null when TTS is unavailable (the caller then
// tells the client to speak the answer with the browser's own voice instead).
export async function speak({ text, fetchImpl = fetch }) {
  try {
    const res = await fetchImpl('https://api.groq.com/openai/v1/audio/speech', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: ttsModel(), voice: ttsVoice(), input: String(text || '').slice(0, 1200), response_format: 'wav' }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch { return null; }
}
