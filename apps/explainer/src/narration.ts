/**
 * What the explainer says, scene by scene. Shared by scripts/voice.ts (makes the audio + timings) and the video.
 * `marks` name a phrase in `text`: the scene reveals something at the moment that phrase is spoken.
 */
export const SCENES = [
  {
    id: "title",
    text: "Before the demo, here's how the backend works. It's built on Cloudflare Workers, Durable Objects, and Postgres.",
    marks: { workers: "Cloudflare Workers", dos: "Durable Objects", pg: "and Postgres" },
  },
  {
    id: "problem",
    text: "The hard part of ride-hailing isn't the API. It's real-time state. Thousands of drivers send their location every few seconds. Every ride has timers. And two customers must never get the same driver.",
    marks: { pings: "Thousands", timers: "Every ride has timers", same: "two customers" },
  },
  {
    id: "zones",
    text: "So the city is split into zones of about five kilometres. Each zone gets its own Durable Object: a small stateful server with its own memory, storage, WebSocket connections, and alarms.",
    marks: { grid: "split into zones", object: "Each zone", props: "its own memory" },
  },
  {
    id: "architecture",
    text: "Both apps connect to a Worker. It checks the token and hands each connection to the right zone. In each zone, the match object keeps the free drivers and finds the nearest one. The ride object runs the ride: the offers, the status, and the timers. And Postgres is the source of truth for rides and money.",
    marks: { apps: "Both apps", worker: "a Worker", match: "the match object", ride: "The ride object", pg: "And Postgres" },
  },
  {
    id: "why",
    text: "This design gives three things. First, driver positions live in memory, so a location ping never touches a database. Second, a Durable Object handles one request at a time, so reserving a driver needs no distributed lock. Third, timers are stored as alarms, so a deploy in the middle of a ride doesn't lose them.",
    marks: { first: "First", second: "Second", third: "Third" },
  },
  {
    id: "postgres",
    text: "Money always goes through Postgres first. Every status change and every payment is written in one transaction, and only then applied in the Durable Object and pushed to the apps. If Postgres is down, the action is refused and nothing changes. Refused always means it didn't happen.",
    marks: { write: "Every status change", apply: "only then", down: "If Postgres is down", refused: "Refused always" },
  },
  {
    id: "outro",
    text: "Now, let's follow one full ride.",
    marks: {},
  },
] as const;

export type SceneId = (typeof SCENES)[number]["id"];
export const FPS = 30;
/** silence after each scene's narration, seconds */
export const GAP_S = 0.8;
