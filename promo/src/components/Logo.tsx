import React from "react";
import { useCurrentFrame, interpolate, spring } from "remotion";
import { staticFile } from "remotion";
import { FPS, COLORS } from "../constants";

type LogoProps = {
  from?: number;
  size?: number;
  showText?: boolean;
};

export const Logo: React.FC<LogoProps> = ({ from = 0, size = 120, showText = true }) => {
  const frame = useCurrentFrame();

  const scale = spring({
    frame: frame - from,
    fps: FPS,
    config: { damping: 15, stiffness: 180 },
    from: 0,
    to: 1,
  });

  const opacity = interpolate(frame, [from, from + 8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 16,
        opacity,
        transform: `scale(${scale})`,
      }}
    >
      <img
        src={staticFile("d-OP-icon.png")}
        alt=""
        width={size}
        height={size}
        style={{
          borderRadius: 20,
          boxShadow: `0 0 40px ${COLORS.accent}40`,
        }}
      />
      {showText && (
        <div
          style={{
            fontSize: size * 0.45,
            fontWeight: 900,
            color: COLORS.text,
            letterSpacing: "0.04em",
          }}
        >
          d-OP
        </div>
      )}
    </div>
  );
};
