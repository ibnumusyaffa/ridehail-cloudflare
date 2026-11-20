/**
 * explainer + demo → out/full.mp4 (+ out/full.srt).
 *   out/explainer.mp4            from `pnpm render`
 *   ../e2e/videos/demo.mp4       from `pnpm --filter @gojek/e2e demo:video`
 * Both are brought to 1440×900, 30 fps, stereo 48 kHz, then joined. Subtitles of the demo are shifted by the
 * explainer's length.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const EXPLAINER = "out/explainer.mp4";
const DEMO = "../e2e/videos/demo.mp4";
for (const f of [EXPLAINER, DEMO]) if (!existsSync(f)) throw new Error(`missing ${f}`);

const duration = (f: string) =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString());

const norm = (i: number) =>
  `[${i}:v]scale=1440:900:force_original_aspect_ratio=decrease,pad=1440:900:(ow-iw)/2:(oh-ih)/2:color=0x0b1220,fps=30,format=yuv420p,setsar=1[v${i}];` +
  `[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`;

execFileSync("ffmpeg", [
  "-y", "-loglevel", "error", "-i", EXPLAINER, "-i", DEMO,
  "-filter_complex", `${norm(0)};${norm(1)};[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]`,
  "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-c:a", "aac", "-b:a", "160k",
  "-movflags", "+faststart", "out/full.mp4",
]);

// subtitles: explainer as is, demo shifted by the explainer's length
const shift = duration(EXPLAINER) * 1000;
const parse = (t: string) => {
  const [h, m, rest] = t.split(":");
  const [s, ms] = rest!.split(",");
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms);
};
const fmt = (ms: number) => {
  const p = (n: number, w = 2) => String(Math.floor(n)).padStart(w, "0");
  return `${p(ms / 3_600_000)}:${p((ms / 60_000) % 60)}:${p((ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
const cues = (file: string, offset: number) =>
  readFileSync(file, "utf8").trim().split(/\n\s*\n/).map((block) => {
    const lines = block.split("\n");
    const [a, b] = lines[1]!.split(" --> ");
    return `${fmt(parse(a!) + offset)} --> ${fmt(parse(b!) + offset)}\n${lines.slice(2).join("\n")}`;
  });
const all = [...cues("out/explainer.srt", 0), ...(existsSync("../e2e/videos/demo.srt") ? cues("../e2e/videos/demo.srt", shift) : [])];
writeFileSync("out/full.srt", all.map((c, i) => `${i + 1}\n${c}\n`).join("\n"));

console.log(`saved out/full.mp4 (${duration("out/full.mp4").toFixed(1)} s) and out/full.srt`);
