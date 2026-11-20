import type React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Arrow, C, FONT, Heading, Node, Packet, Pop, type SceneTiming, useAppear, useMark } from "../ui";

type Props = { t: SceneTiming };

// ------------------------------------------------------------------ title

export function Title({ t }: Props) {
  const p = useAppear(0);
  const pill = (label: string, color: string, key: string) => (
    <Pop at={useMark(t, key)} style={{ padding: "12px 26px", borderRadius: 999, border: `2px solid ${color}`, color: C.text, font: `700 24px ${FONT}` }}>
      {label}
    </Pop>
  );
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 26, paddingBottom: 80 }}>
      <div style={{ color: C.cf, font: `700 20px ${FONT}`, letterSpacing: ".16em", opacity: p }}>RIDE-HAILING BACKEND</div>
      <div style={{ color: C.text, font: `800 72px ${FONT}`, letterSpacing: "-.02em", opacity: p, transform: `translateY(${(1 - p) * 20}px)` }}>
        How it works
      </div>
      <div style={{ display: "flex", gap: 18, marginTop: 18, height: 60 }}>
        {pill("Cloudflare Workers", C.cf, "workers")}
        {pill("Durable Objects", C.cf, "dos")}
        {pill("Postgres", C.pg, "pg")}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the problem

function Card({ at, title, sub, children }: { at: number; title: string; sub: string; children: React.ReactNode }) {
  return (
    <Pop at={at} style={{ width: 380, height: 420, borderRadius: 24, background: C.panel, border: `1px solid ${C.line}`, display: "flex", flexDirection: "column", alignItems: "center", padding: 28, gap: 16 }}>
      <div style={{ height: 220, width: "100%", position: "relative" }}>{children}</div>
      <div style={{ color: C.text, font: `700 26px ${FONT}`, textAlign: "center" }}>{title}</div>
      <div style={{ color: C.muted, font: `500 18px/1.4 ${FONT}`, textAlign: "center" }}>{sub}</div>
    </Pop>
  );
}

/** pseudo-random but stable positions */
const rand = (i: number) => {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

function Pings({ at }: { at: number }) {
  const frame = useCurrentFrame();
  return (
    <>
      {Array.from({ length: 34 }, (_, i) => {
        const phase = (frame - at + rand(i) * 60) % 60;
        const ring = frame >= at ? phase / 60 : 0;
        return (
          <div key={i} style={{ position: "absolute", left: `${8 + rand(i + 1) * 84}%`, top: `${8 + rand(i + 2) * 84}%` }}>
            <div style={{ width: 10, height: 10, borderRadius: 5, background: C.driver, transform: "translate(-50%,-50%)" }} />
            <div style={{
              position: "absolute", left: 0, top: 0, width: 34, height: 34, borderRadius: 17, border: `2px solid ${C.driver}`,
              transform: `translate(-50%,-50%) scale(${ring})`, opacity: (1 - ring) * 0.8,
            }} />
          </div>
        );
      })}
    </>
  );
}

function Timer({ at }: { at: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const left = Math.max(0, 15 - Math.floor(Math.max(0, frame - at) / fps) % 16);
  const prog = left / 15;
  const r = 80;
  const len = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 220 220" style={{ position: "absolute", inset: 0, margin: "auto", width: 220, height: 220 }}>
      <circle cx={110} cy={110} r={r} fill="none" stroke={C.line} strokeWidth={12} />
      <circle cx={110} cy={110} r={r} fill="none" stroke={C.cf} strokeWidth={12} strokeLinecap="round"
        strokeDasharray={len} strokeDashoffset={len * (1 - prog)} transform="rotate(-90 110 110)" />
      <text x={110} y={122} textAnchor="middle" fill={C.text} style={{ font: `800 44px ${FONT}` }}>{left}s</text>
    </svg>
  );
}

function OneDriver({ at }: { at: number }) {
  const frame = useCurrentFrame();
  const cross = interpolate(frame, [at + 25, at + 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const dot = (x: number, y: number, color: string, label: string) => (
    <div style={{ position: "absolute", left: x, top: y, transform: "translate(-50%,-50%)", textAlign: "center" }}>
      <div style={{ width: 46, height: 46, borderRadius: 23, background: color, margin: "0 auto" }} />
      <div style={{ color: C.muted, font: `600 15px ${FONT}`, marginTop: 6 }}>{label}</div>
    </div>
  );
  return (
    <>
      <Arrow x1={70} y1={60} x2={240} y2={110} at={at} color={C.customer} />
      <Arrow x1={70} y1={175} x2={240} y2={125} at={at + 8} color={C.red} />
      {dot(50, 60, C.customer, "Customer A")}
      {dot(50, 180, C.customer, "Customer B")}
      {dot(280, 115, C.driver, "Driver")}
      <div style={{ position: "absolute", left: 150, top: 150, color: C.red, font: `900 44px ${FONT}`, opacity: cross, transform: `translate(-50%,-50%) scale(${cross})` }}>✕</div>
    </>
  );
}

export function Problem({ t }: Props) {
  return (
    <>
      <Heading kicker="The problem">The hard part is real-time state</Heading>
      <div style={{ position: "absolute", top: 210, left: 0, right: 0, display: "flex", justifyContent: "center", gap: 36 }}>
        <Card at={useMark(t, "pings")} title="Thousands of pings" sub="Every driver sends a location every few seconds"><Pings at={useMark(t, "pings")} /></Card>
        <Card at={useMark(t, "timers")} title="Timers everywhere" sub="Offers expire in 15 s, a search gives up after 2 min"><Timer at={useMark(t, "timers")} /></Card>
        <Card at={useMark(t, "same")} title="One driver, one ride" sub="Two customers must never get the same driver"><OneDriver at={useMark(t, "same")} /></Card>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ zones

export function Zones({ t }: Props) {
  const frame = useCurrentFrame();
  const grid = useMark(t, "grid");
  const obj = useMark(t, "object");
  const props = useMark(t, "props");
  const cols = 6;
  const rows = 4;
  const size = 110;
  const ox = 140;
  const oy = 230;
  const hot = { c: 3, r: 1 };
  const lineT = interpolate(frame, [grid, grid + 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const glow = useAppear(obj);
  return (
    <>
      <Heading kicker="Zones">Split the city into ~5 km zones</Heading>
      {/* drivers on the "map" */}
      {Array.from({ length: 70 }, (_, i) => (
        <div key={i} style={{
          position: "absolute", left: ox + rand(i + 7) * cols * size, top: oy + rand(i + 9) * rows * size, width: 8, height: 8,
          borderRadius: 4, background: C.driver, opacity: 0.85,
        }} />
      ))}
      <svg style={{ position: "absolute", inset: 0 }} width={1440} height={900}>
        {Array.from({ length: cols + 1 }, (_, i) => (
          <line key={`c${i}`} x1={ox + i * size} y1={oy} x2={ox + i * size} y2={oy + rows * size * lineT} stroke={C.line} strokeWidth={2} />
        ))}
        {Array.from({ length: rows + 1 }, (_, i) => (
          <line key={`r${i}`} x1={ox} y1={oy + i * size} x2={ox + cols * size * lineT} y2={oy + i * size} stroke={C.line} strokeWidth={2} />
        ))}
        <rect x={ox + hot.c * size} y={oy + hot.r * size} width={size} height={size} fill={`${C.cf}33`} stroke={C.cf} strokeWidth={3} opacity={glow} />
      </svg>
      <Arrow x1={ox + (hot.c + 1) * size} y1={oy + (hot.r + 0.5) * size} x2={960} y2={oy + 1.5 * size} at={obj + 6} color={C.cf} />
      <Pop at={obj + 10} style={{
        position: "absolute", left: 980, top: 250, width: 360, borderRadius: 20, background: C.panel, border: `2px solid ${C.cf}`,
        padding: 26, boxShadow: `0 0 40px ${C.cf}33`,
      }}>
        <div style={{ color: C.cf, font: `700 15px ${FONT}`, letterSpacing: ".12em" }}>ONE ZONE =</div>
        <div style={{ color: C.text, font: `800 32px ${FONT}`, marginTop: 6 }}>a Durable Object</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 20 }}>
          {["Memory", "Storage", "WebSockets", "Alarms"].map((x, i) => (
            <Pop key={x} at={props + i * 6} from={10} style={{ padding: "10px 12px", borderRadius: 12, background: "#1b2742", color: C.text, font: `600 18px ${FONT}`, textAlign: "center" }}>
              {x}
            </Pop>
          ))}
        </div>
      </Pop>
    </>
  );
}

// ------------------------------------------------------------------ architecture

export function Architecture({ t }: Props) {
  const apps = useMark(t, "apps");
  const worker = useMark(t, "worker");
  const match = useMark(t, "match");
  const ride = useMark(t, "ride");
  const pg = useMark(t, "pg");
  const zone = useAppear(match - 8);
  const flow = pg + 30;
  // centres
  const A = { cust: { x: 170, y: 340 }, drv: { x: 170, y: 560 }, wk: { x: 520, y: 450 }, m: { x: 880, y: 345 }, r: { x: 880, y: 565 }, pg: { x: 1250, y: 455 } };
  return (
    <>
      <Heading kicker="Architecture">One request, end to end</Heading>
      {/* Cloudflare + zone frames */}
      <div style={{ position: "absolute", left: 370, top: 200, width: 690, height: 500, borderRadius: 24, border: `2px dashed ${C.cf}88`, opacity: useAppear(worker) }}>
        <div style={{ position: "absolute", top: -14, left: 24, background: C.bg, padding: "0 10px", color: C.cf, font: `700 16px ${FONT}`, letterSpacing: ".1em" }}>CLOUDFLARE</div>
      </div>
      <div style={{ position: "absolute", left: 720, top: 240, width: 320, height: 430, borderRadius: 20, border: `2px solid ${C.line}`, opacity: zone }}>
        <div style={{ position: "absolute", top: -13, left: 20, background: C.bg, padding: "0 8px", color: C.muted, font: `700 15px ${FONT}`, letterSpacing: ".1em" }}>PER ZONE</div>
      </div>

      <Node x={A.cust.x} y={A.cust.y} w={200} title="Customer app" color={C.customer} at={apps} />
      <Node x={A.drv.x} y={A.drv.y} w={200} title="Driver app" color={C.driver} at={apps + 6} />
      <Node x={A.wk.x} y={A.wk.y} w={190} title="Worker" sub="token · route to zone" color={C.cf} at={worker} />
      <Node x={A.m.x} y={A.m.y} w={260} title="MatchDO" sub="free drivers · find nearest" color={C.cf} at={match} />
      <Node x={A.r.x} y={A.r.y} w={260} title="RideDO" sub="offers · status · timers" color={C.cf} at={ride} />
      <Node x={A.pg.x} y={A.pg.y} w={220} h={120} title="Postgres" sub="rides + money (truth)" color={C.pg} at={pg} />

      <Arrow x1={270} y1={A.cust.y} x2={425} y2={430} at={worker} label="REST + WS" labelDy={-18} />
      <Arrow x1={270} y1={A.drv.y} x2={425} y2={470} at={worker + 4} />
      <Arrow x1={615} y1={430} x2={750} y2={A.m.y} at={match} label="WS" />
      <Arrow x1={615} y1={470} x2={750} y2={A.r.y} at={ride} label="WS + RPC" labelDy={48} />
      <Arrow x1={880} y1={393} x2={880} y2={517} at={ride + 6} both label="RPC" />
      <Arrow x1={1010} y1={A.r.y} x2={1140} y2={480} at={pg} color={C.pg} />
      <Arrow x1={1010} y1={A.m.y} x2={1140} y2={430} at={pg + 4} color={C.pg} />
      <Arrow x1={520} y1={498} x2={1250} y2={515} bend={380} at={pg + 10} color={C.pg} label="REST: login, wallet, history" labelDy={26} dur={22} />

      {/* traffic once everything is on screen */}
      <Packet x1={270} y1={A.drv.y} x2={425} y2={470} at={flow} color={C.driver} />
      <Packet x1={615} y1={430} x2={750} y2={A.m.y} at={flow + 10} color={C.driver} offset={20} />
      <Packet x1={270} y1={A.cust.y} x2={425} y2={430} at={flow + 5} color={C.customer} offset={10} />
      <Packet x1={615} y1={470} x2={750} y2={A.r.y} at={flow + 15} color={C.customer} offset={30} />
      <Packet x1={1010} y1={A.r.y} x2={1140} y2={480} at={flow + 20} color={C.pg} period={60} />
    </>
  );
}

// ------------------------------------------------------------------ why durable objects

export function Why({ t }: Props) {
  const items = [
    { key: "first", n: "1", title: "State in memory", sub: "A location ping never touches a database. Positions are saved every 30 s." },
    { key: "second", n: "2", title: "One request at a time", sub: "Reserving a driver is a check in memory. No distributed lock." },
    { key: "third", n: "3", title: "Timers are stored alarms", sub: "Offer and search timers survive a deploy in the middle of a ride." },
  ];
  return (
    <>
      <Heading kicker="Why Durable Objects">Three things for free</Heading>
      <div style={{ position: "absolute", top: 240, left: 0, right: 0, display: "flex", justifyContent: "center", gap: 32 }}>
        {items.map((it) => (
          <Pop key={it.key} at={useMark(t, it.key)} style={{
            width: 390, height: 330, borderRadius: 24, background: C.panel, border: `1px solid ${C.line}`, padding: 34,
            display: "flex", flexDirection: "column", gap: 18,
          }}>
            <div style={{ width: 64, height: 64, borderRadius: 32, background: `${C.cf}22`, border: `2px solid ${C.cf}`, color: C.cf, font: `800 30px ${FONT}`, display: "grid", placeItems: "center" }}>{it.n}</div>
            <div style={{ color: C.text, font: `800 30px ${FONT}` }}>{it.title}</div>
            <div style={{ color: C.muted, font: `500 21px/1.45 ${FONT}` }}>{it.sub}</div>
          </Pop>
        ))}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ postgres first

export function PostgresFirst({ t }: Props) {
  const frame = useCurrentFrame();
  const write = useMark(t, "write");
  const apply = useMark(t, "apply");
  const down = useMark(t, "down");
  const refused = useMark(t, "refused");
  const isDown = frame >= down;
  const okMark = useAppear(write + 18);
  const redT = interpolate(frame, [down, down + 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const P = { ride: { x: 270, y: 470 }, pg: { x: 720, y: 470 }, apps: { x: 1170, y: 470 } };
  return (
    <>
      <Heading kicker="Consistency">Postgres first, then the Durable Object</Heading>
      <Node x={P.ride.x} y={P.ride.y} w={240} title="RideDO" sub="ride state" color={C.cf} at={0} />
      <Node x={P.pg.x} y={P.pg.y} w={250} h={130} title="Postgres" sub="status + payment" color={isDown ? C.red : C.pg} at={0}>
        <div style={{ position: "absolute", top: -22, right: -22, width: 44, height: 44, borderRadius: 22, display: "grid", placeItems: "center", font: `900 24px ${FONT}`, color: "#fff",
          background: isDown ? C.red : C.ok, transform: `scale(${isDown ? redT : okMark})` }}>{isDown ? "✕" : "✓"}</div>
      </Node>
      <Node x={P.apps.x} y={P.apps.y} w={240} title="Both apps" sub="WebSocket push" color={C.customer} at={0} dim={isDown} />

      <Arrow x1={390} y1={455} x2={595} y2={455} at={write} color={isDown ? C.red : C.pg} label="① one transaction" labelDy={-22} />
      <Arrow x1={270} y1={410} x2={1170} y2={410} bend={-260} at={apply} color={isDown ? C.line : C.customer} label="② then apply + push" labelDy={-8} dur={22} />

      <Pop at={down + 6} style={{ position: "absolute", left: 0, right: 0, top: 590, textAlign: "center", color: C.red, font: `700 26px ${FONT}` }}>
        Postgres down → action refused, nothing changes
      </Pop>
      <Pop at={refused} style={{ position: "absolute", left: 0, right: 0, top: 650, display: "flex", justifyContent: "center" }}>
        <div style={{ padding: "14px 30px", borderRadius: 16, background: `${C.cf}22`, border: `2px solid ${C.cf}`, color: C.text, font: `800 30px ${FONT}` }}>
          “Refused” always means “didn’t happen”
        </div>
      </Pop>
    </>
  );
}

// ------------------------------------------------------------------ outro

export function Outro(_: Props) {
  const p = useAppear(0);
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", paddingBottom: 80 }}>
      <div style={{ color: C.text, font: `800 64px ${FONT}`, opacity: p, transform: `translateX(${(1 - p) * -30}px)` }}>
        Let’s see one ride <span style={{ color: C.cf }}>→</span>
      </div>
    </div>
  );
}
