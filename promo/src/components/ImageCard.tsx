import React from "react";
import { useCurrentFrame, interpolate, spring } from "remotion";
import { staticFile } from "remotion";
import { FPS, WIDTH, COLORS } from "../constants";

type ImageCardProps = {
  src: string;
  from: number;
  alt?: string;
};

export const ImageCard: React.FC<ImageCardProps> = ({ src, from, alt = "" }) => {
  const frame = useCurrentFrame();

  const progress = spring({
    frame: frame - from,
    fps: FPS,
    config: { damping: 20, stiffness: 150, mass: 0.9 },
    from: 0,
    to: 1,
  });

  const x = interpolate(progress, [0, 1], [WIDTH * 0.25, 0]);
  const opacity = interpolate(progress, [0, 0.6, 1], [0, 1, 1]);
  const scale = interpolate(progress, [0, 1], [0.92, 1]);

  return (
    <div
      style={{
        width: "84%",
        maxWidth: 900,
        borderRadius: 20,
        overflow: "hidden",
        border: `1px solid ${COLORS.border}`,
        background: COLORS.panel,
        boxShadow: `0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px ${COLORS.border}`,
        transform: `translateX(${x}px) scale(${scale})`,
        opacity,
      }}
    >
      <img
        src={staticFile(src)}
        alt={alt}
        style={{
          width: "100%",
          height: "auto",
          display: "block",
        }}
      />
    </div>
  );
};
