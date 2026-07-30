import React from "react";
import { useCurrentFrame, interpolate, spring, Easing } from "remotion";
import { FPS } from "../constants";

type AnimatedTextProps = {
  children: React.ReactNode;
  from?: number;
  durationInFrames?: number;
  style?: React.CSSProperties;
  delay?: number;
  as?: "h1" | "h2" | "p" | "span" | "div";
};

export const AnimatedText: React.FC<AnimatedTextProps> = ({
  children,
  from = 0,
  durationInFrames = 30,
  style,
  delay = 0,
  as: Component = "div",
}) => {
  const frame = useCurrentFrame();
  const start = from + delay;

  const opacity = interpolate(
    frame,
    [start, start + 8],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const y = spring({
    frame: frame - start,
    fps: FPS,
    config: { damping: 20, stiffness: 200, mass: 0.8 },
    from: 40,
    to: 0,
  });

  const scale = interpolate(
    frame,
    [start + durationInFrames - 10, start + durationInFrames],
    [1, 0.96],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.ease) }
  );

  return (
    <Component
      style={{
        opacity,
        transform: `translateY(${y}px) scale(${scale})`,
        ...style,
      }}
    >
      {children}
    </Component>
  );
};
