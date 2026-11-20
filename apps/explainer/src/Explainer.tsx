import type React from "react";
import { AbsoluteFill, Audio, interpolate, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Architecture, Outro, PostgresFirst, Problem, Title, Why, Zones } from "./scenes";
import { C, FONT, type SceneTiming, Subtitle } from "./ui";
import voice from "./voice.json";

const VIEWS: Record<string, (p: { t: SceneTiming }) => React.ReactNode> = {
  title: Title,
  problem: Problem,
  zones: Zones,
  architecture: Architecture,
  why: Why,
  postgres: PostgresFirst,
  outro: Outro,
};

export const scenes = (voice as { scenes: SceneTiming[] }).scenes;

/** Fade a scene in and out so cuts are soft. */
function Fade({ frames, children }: { frames: number; children: React.ReactNode }) {
  const f = useCurrentFrame();
  const o = interpolate(f, [0, 10, frames - 10, frames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
}

export function Explainer() {
  const { fps } = useVideoConfig();
  let from = 0;
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: FONT }}>
      {scenes.map((t) => {
        const frames = Math.round(t.duration * fps);
        const View = VIEWS[t.id]!;
        const seq = (
          <Sequence key={t.id} from={from} durationInFrames={frames} name={t.id}>
            <Audio src={staticFile(`voice/${t.id}.mp3`)} />
            <Fade frames={frames}>
              <View t={t} />
            </Fade>
            <Subtitle t={t} />
          </Sequence>
        );
        from += frames;
        return seq;
      })}
    </AbsoluteFill>
  );
}
