import React from "react";
import { useCurrentFrame, interpolate, Easing } from "remotion";
import { WIDTH, HEIGHT, COLORS, DURATION_IN_FRAMES } from "../constants";

const PARTICLES = Array.from({ length: 24 }, (_, i) => ({
  id: i,
  x: Math.random() * WIDTH,
  y: Math.random() * HEIGHT,
  size: 2 + Math.random() * 4,
  speed: 0.3 + Math.random() * 0.7,
  delay: Math.random() * 60,
}));

export const Background: React.FC = () => {
  const frame = useCurrentFrame();

  const glowOpacity = interpolate(
    frame,
    [0, DURATION_IN_FRAMES],
    [0.35, 0.55],
    { extrapolateRight: "clamp" }
  );

  const scanY = interpolate(frame, [0, DURATION_IN_FRAMES], [-200, HEIGHT + 200], {
    extrapolateRight: "clamp",
    easing: Easing.linear,
  });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: COLORS.bg,
        overflow: "hidden",
      }}
    >
      {/* 大きな赤いグロー */}
      <div
        style={{
          position: "absolute",
          top: HEIGHT * 0.15,
          left: WIDTH * 0.5 - 600,
          width: 1200,
          height: 1200,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${COLORS.accent} 0%, transparent 70%)`,
          opacity: glowOpacity,
          filter: "blur(120px)",
        }}
      />

      <div
        style={{
          position: "absolute",
          bottom: -400,
          right: -300,
          width: 1000,
          height: 1000,
          borderRadius: "50%",
          background: `radial-gradient(circle, rgba(230,0,18,0.5) 0%, transparent 70%)`,
          opacity: 0.25,
          filter: "blur(100px)",
        }}
      />

      {/* グリッド線 */}
      <svg
        width={WIDTH}
        height={HEIGHT}
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.08,
        }}
      >
        <defs>
          <pattern id="grid" width="60" height="60" patternUnits="userSpaceOnUse">
            <path d="M 60 0 L 0 0 0 60" fill="none" stroke={COLORS.text} strokeWidth="1" />
          </pattern>
        </defs>
        <rect width={WIDTH} height={HEIGHT} fill="url(#grid)" />
      </svg>

      {/* 粒子 */}
      {PARTICLES.map((p) => {
        const y = (p.y - frame * p.speed * 1.5 + p.delay * 2) % (HEIGHT + 100);
        const opacity = interpolate(
          frame,
          [p.delay, p.delay + 20, p.delay + 80],
          [0, 0.6, 0],
          { extrapolateRight: "clamp" }
        );
        return (
          <div
            key={p.id}
            style={{
              position: "absolute",
              left: p.x,
              top: y - 50,
              width: p.size,
              height: p.size,
              borderRadius: "50%",
              background: COLORS.accent,
              opacity,
              boxShadow: `0 0 ${p.size * 2}px ${COLORS.accent}`,
            }}
          />
        );
      })}

      {/* 走査線 */}
      <div
        style={{
          position: "absolute",
          top: scanY,
          left: 0,
          right: 0,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${COLORS.accent}, transparent)`,
          opacity: 0.5,
          filter: "blur(1px)",
        }}
      />

      {/* ビネット */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at center, transparent 40%, rgba(0,0,0,0.6) 100%)",
          pointerEvents: "none",
        }}
      />
    </div>
  );
};
