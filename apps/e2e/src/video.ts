/**
 * Record one full ride as a narrated video: customer app left, driver app right, subtitles at the bottom.
 *
 *   pnpm dev            # in another terminal: API :8787 + customer :5173 + driver :5174
 *   pnpm demo:video     # → apps/e2e/videos/demo.mp4 (+ demo.srt)
 *
 * Both apps run as iframes on one "stage" page, so one recording shows both in sync. Each narration line is spoken,
 * shown as the on-screen subtitle and written as a cue in the .srt file. The next step waits until the current line
 * has been spoken.
 *
 * Voice: ElevenLabs when ELEVENLABS_API_KEY is set (env or apps/e2e/.env.local), otherwise macOS `say`.
 * Spoken lines are cached in videos/.voice-cache by voice + text, so re-recording only pays for changed lines.
 * Options: --trip <presetId>, --speed <m/s, default 150 (the driver app max)>, --slowmo <ms, default 900>, --headed,
 * --voice-id <ElevenLabs voice, default Charlie>, --voice <say voice, default Karen>, --rate <say words/min, default 170>.
 * Needs ffmpeg.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect, type Frame, type Page } from "@playwright/test";
import {
  customerOrder, driverAcceptOffer, driverOnlineNear, driverReachTarget, login, phone, rideStatus, topup, URLS,
} from "./steps";

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : d;
};
const TRIP = arg("trip", "monas-hi");
const SPEED = Number(arg("speed", "150"));
const SLOWMO = Number(arg("slowmo", "900"));
const VOICE = arg("voice", "Karen");
const RATE = arg("rate", "170");
/** ElevenLabs "Charlie": Australian male, conversational */
const VOICE_ID = arg("voice-id", "IKne3meq5aSn9XLyUdCD");
const ELEVEN_MODEL = "eleven_multilingual_v2";

/** KEY=value lines from apps/e2e/.env.local (gitignored), without overriding the real environment */
function loadEnvLocal() {
  const f = resolve(".env.local");
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
  }
}
loadEnvLocal();
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;

const W = 1440;
const H = 900;
const CAPTION_H = 120;
const OUT = resolve("videos");
const VOICE_DIR = resolve(OUT, ".voice-cache");

// ---------------------------------------------------------------- script: what is shown and said

const LINES = {
  intro: ["Ride-hailing backend", "This is a ride-hailing backend I built on Cloudflare. Let's follow one full ride: the customer app is on the left, and the driver app is on the right."],
  topup: ["Customer tops up the wallet", "First, the customer tops up their wallet. Each top-up carries an idempotency key, so a retried request never adds money twice."],
  online: ["Driver goes online", "The driver goes online. They join the pool of free drivers in their zone, which lives in memory inside a Durable Object."],
  order: ["Customer orders a ride", "The customer orders a ride and pays by wallet. Postgres creates the ride and holds the fare, in the same transaction."],
  offer: ["The nearest driver gets an offer", "The server offers the ride to the nearest driver. Each driver gets fifteen seconds. If they reject it or let it expire, the next driver gets it."],
  pickup: ["Driver heads to the pickup", "The driver accepts and heads to the pickup. Their location streams over a WebSocket, so the customer sees the scooter move in real time."],
  pings: ["Location pings stay in memory", "Location pings are throttled and kept in memory. Nothing is written to a database on every ping, which keeps the cost low with thousands of drivers."],
  arrived: ["Driver marks Arrived", "The driver marks arrived. This only works within two hundred metres of the pickup, so a driver can't fake it from home."],
  start: ["Trip starts", "The trip starts. Every status change is written to Postgres first, and only then pushed to both apps."],
  trip: ["On the way to the destination", "During the trip, the route is thinned and stored, so it can be checked later if there is a dispute."],
  complete: ["Driver completes the trip", "The driver completes the trip. Completion and payment happen in one transaction, so the fare is charged exactly once."],
  rate: ["Customer rates the driver", "The customer rates the driver."],
  wallets: ["Both wallets", "On the wallet screens: the customer paid the fare, and the driver earned the fare minus the platform commission."],
  outro: ["Thanks for watching", "Every step in this video is covered by integration and end-to-end tests. Thanks for watching."],
} as const satisfies Record<string, readonly [string, string]>;
type Line = keyof typeof LINES;

/** One line → audio file, from the cache when this voice already said this exact text. */
async function speak(text: string): Promise<string> {
  const engine = ELEVEN_KEY ? `eleven:${VOICE_ID}:${ELEVEN_MODEL}` : `say:${VOICE}:${RATE}`;
  const hash = createHash("sha256").update(`${engine}\n${text}`).digest("hex").slice(0, 16);
  const file = resolve(VOICE_DIR, `${hash}.${ELEVEN_KEY ? "mp3" : "aiff"}`);
  if (existsSync(file)) return file;
  if (!ELEVEN_KEY) {
    execFileSync("say", ["-v", VOICE, "-r", RATE, "-o", file, text]);
    return file;
  }
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": ELEVEN_KEY, "content-type": "application/json" },
    body: JSON.stringify({ text, model_id: ELEVEN_MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2 } }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

/** Speak every line up front; returns each line's audio file and duration in ms. */
async function synthesize(): Promise<Record<Line, { file: string; ms: number }>> {
  mkdirSync(VOICE_DIR, { recursive: true });
  console.log(`voice: ${ELEVEN_KEY ? `ElevenLabs ${VOICE_ID}` : `macOS say ${VOICE}`}`);
  const out = {} as Record<Line, { file: string; ms: number }>;
  for (const [id, [, text]] of Object.entries(LINES) as [Line, readonly [string, string]][]) {
    const file = await speak(text);
    const sec = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString();
    out[id] = { file, ms: Math.round(Number(sec) * 1000) };
  }
  return out;
}

// ---------------------------------------------------------------- the stage page

const STAGE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: ${W}px; height: ${H}px; background: #0b1220; font-family: -apple-system, system-ui, sans-serif; overflow: hidden; }
  .apps { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; padding: 0 12px; }
  .label { height: 36px; display: flex; align-items: center; gap: 8px; color: #cbd5e1; font: 600 15px system-ui; letter-spacing: .04em; }
  .dot { width: 8px; height: 8px; border-radius: 50%; }
  iframe { display: block; width: 100%; height: ${H - 36 - CAPTION_H}px; border: 0; border-radius: 10px; background: #fff; }
  .caption { position: absolute; left: 0; right: 0; bottom: 0; height: ${CAPTION_H}px; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 6px; padding: 0 48px; text-align: center; }
  #title { color: #fff; font: 700 22px system-ui; }
  #sub { color: #e2e8f0; font: 400 18px/1.4 system-ui; max-width: 1240px; }
  #title, #sub { transition: opacity .3s; }
  .card { position: absolute; inset: 0; z-index: 9; background: #0b1220; display: flex; flex-direction: column; pointer-events: none;
    align-items: center; justify-content: center; gap: 16px; color: #fff; text-align: center; transition: opacity .6s; }
  .card h1 { font: 800 46px system-ui; }
  .card p { font: 400 21px/1.5 system-ui; color: #cbd5e1; max-width: 960px; }
</style></head><body>
  <div class="apps">
    <div><div class="label"><span class="dot" style="background:#22c55e"></span>CUSTOMER APP</div><iframe id="customer" src="${URLS.customer}"></iframe></div>
    <div><div class="label"><span class="dot" style="background:#f59e0b"></span>DRIVER APP</div><iframe id="driver" src="${URLS.driver}"></iframe></div>
  </div>
  <div class="caption"><div id="title"></div><div id="sub"></div></div>
  <div class="card" id="card"><h1>${LINES.intro[0]}</h1><p></p></div>
</body></html>`;

// ---------------------------------------------------------------- narration: on screen, in the audio, in the .srt

const voice = await synthesize();
const cues: { line: Line; start: number; end: number }[] = [];
let t0 = 0;
let speakingUntil = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait until the line being spoken is finished, plus a short breath. */
const settle = async (breath = 700) => sleep(Math.max(0, speakingUntil + breath - Date.now()));

/** Show a line as the subtitle (or as a full-screen card) and start speaking it. Waits for the previous line first. */
async function narrate(page: Page, line: Line, as: "caption" | "card" = "caption") {
  await settle();
  const [title, text] = LINES[line];
  await page.evaluate(({ title, text, as }) => {
    const card = document.getElementById("card")!;
    const a = document.getElementById("title")!;
    const b = document.getElementById("sub")!;
    if (as === "card") {
      card.style.display = "flex";
      card.style.opacity = "1";
      card.querySelector("h1")!.textContent = title;
      card.querySelector("p")!.textContent = text;
      return;
    }
    a.textContent = title;
    b.textContent = text;
  }, { title, text, as });
  const start = Date.now() - t0;
  cues.push({ line, start, end: start + voice[line].ms });
  speakingUntil = Date.now() + voice[line].ms;
  console.log(`▶ ${title}`);
}

async function hideCard(page: Page) {
  await page.evaluate(() => {
    const c = document.getElementById("card")!;
    c.style.opacity = "0";
    setTimeout(() => (c.style.display = "none"), 600);
  });
}

function srt(): string {
  const ts = (ms: number) => {
    const p = (n: number, w = 2) => String(Math.floor(n)).padStart(w, "0");
    return `${p(ms / 3_600_000)}:${p((ms / 60_000) % 60)}:${p((ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  return cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${LINES[c.line][1]}\n`).join("\n");
}

/** Video + every narration line placed at its start time → mp4. */
function render(raw: string, mp4: string) {
  const inputs = cues.flatMap((c) => ["-i", voice[c.line].file]);
  const delays = cues.map((c, i) => `[${i + 1}:a]adelay=${c.start}|${c.start}[a${i}]`).join(";");
  const mix = `${cues.map((_, i) => `[a${i}]`).join("")}amix=inputs=${cues.length}:normalize=0[a]`;
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-i", raw, ...inputs,
    "-filter_complex", `${delays};${mix}`,
    "-map", "0:v", "-map", "[a]",
    "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", mp4,
  ]);
}

// ---------------------------------------------------------------- the ride

mkdirSync(OUT, { recursive: true });
// headless by default: a headed window gets clamped by the screen size and the video shows gray borders
const browser = await chromium.launch({ headless: !process.argv.includes("--headed"), slowMo: SLOWMO });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: OUT, size: { width: W, height: H } } });
await ctx.addInitScript((s) => localStorage.setItem("speed", localStorage.getItem("speed") ?? String(s)), SPEED);
// inside the stage the apps drop their own "RideSim …" label (the stage has one), so the phone fits the iframe
await ctx.addInitScript(() => {
  if (window.top === window) return;
  document.addEventListener("DOMContentLoaded", () => {
    const st = document.createElement("style");
    st.textContent = ".stage-caption { display: none !important; } .stage { grid-template-rows: 1fr !important; }";
    document.head.appendChild(st);
  });
});
const page = await ctx.newPage();
t0 = Date.now();
// served from a localhost URL (not setContent's about:blank) so the iframes are a secure context (crypto.randomUUID)
const STAGE_URL = "http://localhost:5199/stage";
await page.route(STAGE_URL, (r) => r.fulfill({ contentType: "text/html", body: STAGE }));
await page.goto(STAGE_URL);

const frameOf = async (id: string): Promise<Frame> => {
  const f = await (await page.$(`#${id}`))!.contentFrame();
  if (!f) throw new Error(`no frame ${id}`);
  return f;
};
const customer = await frameOf("customer");
const driver = await frameOf("driver");

let ok = false;
try {
  await narrate(page, "intro", "card");
  await Promise.all([
    login(customer, URLS.customer, { phone: phone("0812"), name: "Siti" }),
    login(driver, URLS.driver, { phone: phone("0899"), name: "Budi" }),
  ]);
  await settle();
  await hideCard(page);

  await narrate(page, "topup");
  await topup(customer, 100_000);

  await narrate(page, "online");
  await driverOnlineNear(driver, TRIP);

  await narrate(page, "order");
  await customerOrder(customer, TRIP, "WALLET");

  await narrate(page, "offer");
  await expect(driver.getByTestId("offer")).toBeVisible({ timeout: 15_000 });
  await settle(); // let the viewer see the offer while it's explained
  await driverAcceptOffer(driver);

  await narrate(page, "pickup");
  const reachedPickup = driverReachTarget(driver, 15 * 60_000);
  await narrate(page, "pings");
  await reachedPickup;

  await narrate(page, "arrived");
  await driver.getByTestId("ride-arrived").click();
  await expect(rideStatus(customer)).toHaveAttribute("data-status", "ARRIVED");

  await narrate(page, "start");
  await driver.getByTestId("ride-start").click();
  await expect(rideStatus(customer)).toHaveAttribute("data-status", "ON_TRIP");

  await narrate(page, "trip");
  await driverReachTarget(driver, 15 * 60_000);

  await narrate(page, "complete");
  await driver.getByTestId("ride-complete").click();
  await expect(customer.getByTestId("paid-summary")).toHaveAttribute("data-paid-via", "WALLET");

  await narrate(page, "rate");
  await customer.getByTestId("star-5").click();

  await narrate(page, "wallets");
  await customer.getByTestId("tab-wallet").click();
  await driver.getByTestId("tab-wallet").click();

  await narrate(page, "outro", "card");
  await settle(1500);
  ok = true;
} catch (e) {
  console.error("demo failed:", e);
} finally {
  const video = page.video();
  await ctx.close();
  await browser.close();
  if (video) {
    const raw = resolve(OUT, "demo.webm");
    renameSync(await video.path(), raw);
    for (const f of readdirSync(OUT)) if (f.endsWith(".webm") && f !== "demo.webm") rmSync(resolve(OUT, f));
    writeFileSync(resolve(OUT, "demo.srt"), srt());
    render(raw, resolve(OUT, "demo.mp4"));
    rmSync(raw); // the raw recording has no sound: only the finished video stays
    console.log(`\nsaved ${resolve(OUT, "demo.mp4")} and demo.srt${ok ? "" : " (demo failed part-way)"}`);
  }
}
