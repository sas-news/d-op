import React from "react";
import { useCurrentFrame, interpolate } from "remotion";
import { Background } from "../components/Background";
import { Logo } from "../components/Logo";
import { GlitchText } from "../components/GlitchText";
import { WIDTH, HEIGHT, COLORS } from "../constants";

export const HookScene: React.FC = () => {
  const frame = useCurrentFrame();

  const flash = interpolate(
    frame,
    [0, 4, 8, 12, 16, 20],
    [0, 0.9, 0, 0.7, 0, 0],
    { extrapolateRight: "clamp" }
  );

  return (
    <div
      style={{
        width: WIDTH,
        height: HEIGHT,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 40,
      }}
    >
      <Background />

      {/* フラッシュエフェクト */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: COLORS.accent,
          opacity: flash,
          pointerEvents: "none",
          zIndex: 10,
          mixBlendMode: "screen",
        }}
      />

      <Logo from={5} size={160} showText={false} />

      <div
        style={{
          textAlign: "center",
          zIndex: 5,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <GlitchText
          from={8}
          style={{
            fontSize: 72,
            fontWeight: 900,
            color: COLORS.text,
            lineHeight: 1.1,
            textShadow: `0 0 30px ${COLORS.accent}80`,
          }}
        >
          OPスキップ機能、
        </GlitchText>
        <GlitchText
          from={14}
          style={{
            fontSize: 96,
            fontWeight: 900,
            color: COLORS.accent,
            lineHeight: 1,
            textShadow: `0 0 40px ${COLORS.accent}`,
          }}
        >
          要りません。
        </GlitchText>
      </div>

      <div
        style={{
          opacity: interpolate(frame, [24, 32], [0, 1], { extrapolateRight: "clamp" }),
          transform: `translateY(${interpolate(frame, [24, 32], [20, 0], { extrapolateRight: "clamp" })}px)`,
          color: COLORS.textSecondary,
          fontSize: 28,
          fontWeight: 700,
          letterSpacing: "0.1em",
          zIndex: 5,
        }}
      >
        アニメ好きのための d-OP
      </div>
    </div>
  );
};
