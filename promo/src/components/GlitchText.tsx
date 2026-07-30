import React from "react";
import { useCurrentFrame, interpolate } from "remotion";
import { COLORS } from "../constants";

type GlitchTextProps = {
  children: React.ReactNode;
  from?: number;
  style?: React.CSSProperties;
};

export const GlitchText: React.FC<GlitchTextProps> = ({
  children,
  from = 0,
  style,
}) => {
  const frame = useCurrentFrame();

  const intensity = interpolate(
    frame,
    [from, from + 8, from + 30, from + 45],
    [8, 0, 0, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const offsetX1 = Math.sin(frame * 0.8) * intensity;
  const offsetX2 = Math.cos(frame * 0.6) * intensity;

  return (
    <div
      style={{
        position: "relative",
        display: "inline-block",
        ...style,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 0,
          left: offsetX1,
          color: COLORS.accent,
          opacity: 0.8,
          clipPath: "inset(0 0 50% 0)",
          zIndex: 1,
        }}
      >
        {children}
      </span>
      <span
        style={{
          position: "absolute",
          top: 0,
          left: offsetX2,
          color: "#00e6ff",
          opacity: 0.6,
          clipPath: "inset(50% 0 0 0)",
          zIndex: 1,
        }}
      >
        {children}
      </span>
      <span style={{ position: "relative", zIndex: 2 }}>{children}</span>
    </div>
  );
};
