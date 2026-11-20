/**
 * Speak every scene with ElevenLabs (with character timestamps) and write:
 *   public/voice/<scene>.mp3   the audio the video plays
 *   src/voice.json             per scene: duration, sentence timings (subtitles), mark timings (reveals)
 *   out/explainer.srt          subtitles for the rendered video
 * Results are cached in .voice-cache by voice + text: re-running only pays for scenes whose text changed.
 * Key: ELEVENLABS_API_KEY in the environment, apps/explainer/.env.local or apps/e2e/.env.local.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GAP_S, SCENES } from "../src/narration";

const VOICE_ID = process.env.VOICE_ID ?? "IKne3meq5aSn9XLyUdCD"; // "Charlie": Australian male, same as the demo
const MODEL = "eleven_multilingual_v2";

for (const f of [".env.local", "../e2e/.env.local"]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
  }
}
const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) throw new Error("ELEVENLABS_API_KEY is not set (env, .env.local or ../e2e/.env.local)");

interface Spoken {
  audio_base64: string;
  alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
}

async function speak(text: string): Promise<Spoken> {
  const hash = createHash("sha256").update(`${VOICE_ID}:${MODEL}\n${text}`).digest("hex").slice(0, 16);
  const file = resolve(".voice-cache", `${hash}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as Spoken;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/with-timestamps?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": KEY!, "content-type": "application/json" },
    body: JSON.stringify({ text, model_id: MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2 } }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  const spoken = (await res.json()) as Spoken;
  mkdirSync(".voice-cache", { recursive: true });
  writeFileSync(file, JSON.stringify(spoken));
  return spoken;
}

const ts = (s: number) => {
  const ms = Math.round(s * 1000);
  const p = (n: number, w = 2) => String(Math.floor(n)).padStart(w, "0");
  return `${p(ms / 3_600_000)}:${p((ms / 60_000) % 60)}:${p((ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

mkdirSync("public/voice", { recursive: true });
mkdirSync("out", { recursive: true });
const scenes = [];
const srt: string[] = [];
let offset = 0;
for (const scene of SCENES) {
  const { audio_base64, alignment } = await speak(scene.text);
  writeFileSync(`public/voice/${scene.id}.mp3`, Buffer.from(audio_base64, "base64"));
  const spokenText = alignment.characters.join("");
  if (spokenText !== scene.text) console.warn(`[${scene.id}] alignment text differs from the script; marks may be off`);
  const startAt = (i: number) => alignment.character_start_times_seconds[Math.min(i, alignment.characters.length - 1)]!;
  const endAt = (i: number) => alignment.character_end_times_seconds[Math.min(i, alignment.characters.length - 1)]!;

  const marks: Record<string, number> = {};
  for (const [key, phrase] of Object.entries(scene.marks)) {
    const i = scene.text.indexOf(phrase);
    if (i < 0) throw new Error(`[${scene.id}] mark "${key}": "${phrase}" is not in the text`);
    marks[key] = startAt(i);
  }

  const sentences = [];
  const re = /[^.!?]+[.!?]+/g;
  for (let m = re.exec(scene.text); m; m = re.exec(scene.text)) {
    const lead = m[0].length - m[0].trimStart().length;
    const from = m.index + lead;
    const to = m.index + m[0].length - 1;
    sentences.push({ text: m[0].trim(), start: startAt(from), end: endAt(to) });
  }

  const duration = alignment.character_end_times_seconds.at(-1)! + GAP_S;
  scenes.push({ id: scene.id, duration, marks, sentences });
  for (const s of sentences) srt.push(`${srt.length + 1}\n${ts(offset + s.start)} --> ${ts(offset + s.end)}\n${s.text}\n`);
  offset += duration;
  console.log(`${scene.id.padEnd(13)} ${duration.toFixed(1)} s`);
}
writeFileSync("src/voice.json", JSON.stringify({ scenes }, null, 2));
writeFileSync("out/explainer.srt", srt.join("\n"));
console.log(`total ${offset.toFixed(1)} s`);
