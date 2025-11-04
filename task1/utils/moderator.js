
// Basic list of banned words (expand later)
const bannedWords = ["kill", "hack", "bomb", "attack", "drugs", "terror"];

export function isInputUnsafe(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return bannedWords.some((word) => lower.includes(word));
}


 // Replaces banned words in AI output with [REDACTED].
export function moderateOutput(text) {
  if (!text) return text;
  let clean = text;
  bannedWords.forEach((word) => {
    const regex = new RegExp(`\\b${word}\\b`, "gi");
    clean = clean.replace(regex, "[REDACTED]");
  });
  return clean;
}
