// Browser text-to-speech helper — "Abby talks back". Speaks cleaned text and
// reports when it finishes so a hands-free voice loop can re-open the mic.
// SpeechSynthesis is built into the browser; no audio leaves the device.

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

// Strip markdown / URLs / code noise so the voice reads naturally instead of
// pronouncing asterisks, backticks and raw links.
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code) ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " link ")
    .replace(/[#*`>_~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

let picked: SpeechSynthesisVoice | null = null;
function chooseVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
  if (picked) return picked;
  const voices = synth.getVoices();
  if (!voices.length) return null;
  // Prefer a natural English (ideally female) voice for Abby.
  picked =
    voices.find((v) => /en/i.test(v.lang) && /(samantha|aria|jenny|zira|female|google us english)/i.test(v.name)) ||
    voices.find((v) => /en-US/i.test(v.lang)) ||
    voices.find((v) => /en/i.test(v.lang)) ||
    voices[0] ||
    null;
  return picked;
}

// Warm the voice list (it loads async in some browsers).
if (speechSupported()) {
  try {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = () => { picked = null; chooseVoice(window.speechSynthesis); };
  } catch { /* ignore */ }
}

export function cancelSpeech(): void {
  if (speechSupported()) {
    try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
  }
}

/** Speak `text`. Returns false if unsupported/empty (onEnd still fires). */
export function speak(text: string, opts?: { onEnd?: () => void; onStart?: () => void }): boolean {
  if (!speechSupported()) { opts?.onEnd?.(); return false; }
  const synth = window.speechSynthesis;
  const clean = cleanForSpeech(text);
  if (!clean) { opts?.onEnd?.(); return false; }
  synth.cancel();
  // Cap runaway length so a giant reply can't monopolise the speaker.
  const u = new SpeechSynthesisUtterance(clean.slice(0, 4000));
  const v = chooseVoice(synth);
  if (v) u.voice = v;
  u.rate = 1.02;
  u.pitch = 1.0;
  u.onstart = () => opts?.onStart?.();
  u.onend = () => opts?.onEnd?.();
  u.onerror = () => opts?.onEnd?.();
  synth.speak(u);
  return true;
}
