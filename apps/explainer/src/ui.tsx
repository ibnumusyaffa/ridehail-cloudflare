import type React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const W = 1440;
export const H = 900;
export const SUB_H = 120;

export const C = {
  bg: "#0b1220",
  panel: "#111a2e",
  line: "#24324d",
  text: "#f8fafc",
  muted: "#94a3b8",
  cf: "#f6821f",
  pg: "#4f8fd6",
  customer: "#22c55e",
  driver: "#f59e0b",
  red: "#ef4444",
  ok: "#22c55e",
};
export const FONT = "Inter, -apple-system, 'SF Pro Display', system-ui, sans-serif";

export interface SceneTiming {
  id: string;
  duration: number;
  marks: Record<string, number>;
  sentences: { text: string; start: number; end: number }[];
}

/** 0 → 1 springing in from frame `at`. */
export function useAppear(at: number, delay = 0): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - at - delay, fps, config: { damping: 18, stiffness: 120 } });
}

/** Frame at which a mark is spoken (or the scene start when the mark is unknown). */
export function useMark(t: SceneTiming, key: string): number {
  const { fps } = useVideoConfig();
  return Math.round((t.marks[key] ?? 0) * fps);
}

export function Pop({ at, children, style, from = 24 }: { at: number; children: React.ReactNode; style?: React.CSSProperties; from?: number }) {
  const p = useAppear(at);
  return (
    <div style={{ ...style, opacity: p, transform: `translateY(${(1 - p) * from}px) scale(${0.96 + 0.04 * p})` }}>{children}</div>
  );
}

export function Heading({ children, kicker }: { children: React.ReactNode; kicker?: string }) {
  const p = useAppear(0);
  return (
    <div style={{ position: "absolute", top: 56, left: 0, right: 0, textAlign: "center", opacity: p, transform: `translateY(${(1 - p) * -16}px)` }}>
      {kicker && <div style={{ color: C.cf, font: `700 18px ${FONT}`, letterSpacing: ".14em", textTransform: "uppercase", marginBottom: 10 }}>{kicker}</div>}
      <div style={{ color: C.text, font: `800 46px ${FONT}`, letterSpacing: "-.01em" }}>{children}</div>
    </div>
  );
}

/** A labelled box on the diagram canvas, positioned by its centre. */
export function Node({
  x, y, w = 230, h = 96, title, sub, color, at, dim = false, children,
}: {
  x: number; y: number; w?: number; h?: number; title: string; sub?: string; color: string; at: number; dim?: boolean; children?: React.ReactNode;
}) {
  const p = useAppear(at);
  return (
    <div
      style={{
        position: "absolute", left: x - w / 2, top: y - h / 2, width: w, height: h, borderRadius: 16,
        background: C.panel, border: `2px solid ${color}`, boxShadow: `0 0 ${36 * p}px ${color}44`,
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6,
        opacity: p * (dim ? 0.45 : 1), transform: `scale(${0.85 + 0.15 * p})`,
      }}
    >
      <div style={{ color: C.text, font: `700 24px ${FONT}` }}>{title}</div>
      {sub && <div style={{ color: C.muted, font: `500 16px ${FONT}`, textAlign: "center", padding: "0 10px" }}>{sub}</div>}
      {children}
    </div>
  );
}

/** An arrow that draws itself from (x1,y1) to (x2,y2) starting at frame `at`. */
export function Arrow({
  x1, y1, x2, y2, at, label, color = C.muted, both = false, labelDy = -14, bend = 0, dur = 14,
}: {
  x1: number; y1: number; x2: number; y2: number; at: number; label?: string; color?: string; both?: boolean; labelDy?: number; bend?: number; dur?: number;
}) {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [at, at + dur], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2 + bend;
  const d = `M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`;
  const len = Math.hypot(x2 - x1, y2 - y1) + Math.abs(bend);
  const id = `ah-${x1}-${y1}-${x2}-${y2}`;
  return (
    <svg style={{ position: "absolute", inset: 0, overflow: "visible" }} width={W} height={H}>
      <defs>
        <marker id={id} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
        </marker>
      </defs>
      <path
        d={d} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round"
        strokeDasharray={len * 1.2} strokeDashoffset={len * 1.2 * (1 - t)}
        markerEnd={t > 0.95 ? `url(#${id})` : undefined} markerStart={both && t > 0.95 ? `url(#${id})` : undefined}
      />
      {label && (
        <text x={mx} y={(y1 + y2) / 2 + bend / 2 + labelDy} fill={C.muted} textAnchor="middle" opacity={t} style={{ font: `600 16px ${FONT}` }}>
          {label}
        </text>
      )}
    </svg>
  );
}

/** A dot travelling along a straight segment, looping every `period` frames, from frame `at`. */
export function Packet({ x1, y1, x2, y2, at, period = 40, color, offset = 0 }: { x1: number; y1: number; x2: number; y2: number; at: number; period?: number; color: string; offset?: number }) {
  const frame = useCurrentFrame();
  if (frame < at) return null;
  const t = (((frame - at + offset) % period) + period) % period / period;
  return (
    <div style={{
      position: "absolute", left: x1 + (x2 - x1) * t - 6, top: y1 + (y2 - y1) * t - 6, width: 12, height: 12,
      borderRadius: 6, background: color, boxShadow: `0 0 12px ${color}`, opacity: Math.sin(Math.PI * t),
    }} />
  );
}

/** The sentence being spoken, at the bottom (same look as the demo video). */
export function Subtitle({ t }: { t: SceneTiming }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const now = frame / fps;
  const s = [...t.sentences].reverse().find((x) => now >= x.start - 0.05);
  if (!s) return null;
  const fade = interpolate(now, [s.start - 0.05, s.start + 0.15], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: SUB_H, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 80px" }}>
      <div style={{ color: "#e2e8f0", font: `500 24px/1.4 ${FONT}`, textAlign: "center", opacity: fade, maxWidth: 1200 }}>{s.text}</div>
    </div>
  );
}
