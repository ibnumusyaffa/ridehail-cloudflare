import { Composition } from "remotion";
import { Explainer, scenes } from "./Explainer";
import { FPS } from "./narration";
import { H, W } from "./ui";

export function Root() {
  const durationInFrames = scenes.reduce((n, s) => n + Math.round(s.duration * FPS), 0);
  return <Composition id="Explainer" component={Explainer} durationInFrames={durationInFrames} fps={FPS} width={W} height={H} />;
}
