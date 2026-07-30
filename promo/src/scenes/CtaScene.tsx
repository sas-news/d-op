import React from "react";
import { useCurrentFrame, interpolate, Easing } from "remotion";

import { Background } from "../components/Background";
import { Logo } from "../components/Logo";
import { AnimatedText } from "../components/AnimatedText";
import { WIDTH, HEIGHT, COLORS } from "../constants";


export const CtaScene: React.FC = () => {
  const frame = useCurrentFrame();
  const localFrame = frame - 420;

  const glowPulse = interpolate(
    localFrame % 60,
    [0, 30, 60],
    [0.3, 0.6, 0.3],
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
        gap: 36,
      }}
    >
      <Background />

      <div
        style={{
          position: "absolute",
          top: HEIGHT * 0.5 - 350,
          left: WIDTH * 0.5 - 350,
          width: 700,
          height: 700,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${COLORS.accent} 0%, transparent 70%)`,
          opacity: glowPulse,
          filter: "blur(80px)",
        }}
      />

      <Logo from={420} size={140} />

      <AnimatedText
        from={420}
        delay={12}
        style={{
          fontSize: 76,
          fontWeight: 900,
          color: COLORS.text,
          textAlign: "center",
          lineHeight: 1.1,
          textShadow: `0 0 40px ${COLORS.accent}60`,
        }}
      >
        d-OP
      </AnimatedText>

      <AnimatedText
        from={420}
        delay={22}
        style={{
          fontSize: 40,
          fontWeight: 700,
          color: COLORS.textSecondary,
          textAlign: "center",
        }}
      >
        dアニメストアでOPだけ再生する拡張機能
      </AnimatedText>

      <div
        style={{
          display: "flex",
          gap: 20,
          marginTop: 8,
          opacity: interpolate(localFrame, [40, 52], [0, 1], { extrapolateRight: "clamp" }),
          transform: `translateY(${interpolate(localFrame, [40, 52], [30, 0], { extrapolateRight: "clamp" })}px)`,
        }}
      >
        {["Chrome", "Firefox"].map((browser, i) => (
          <div
            key={browser}
            style={{
              padding: "14px 32px",
              borderRadius: 12,
              background: i === 0 ? COLORS.accent : "transparent",
              border: `2px solid ${i === 0 ? COLORS.accent : COLORS.border}`,
              color: COLORS.text,
              fontSize: 28,
              fontWeight: 800,
              boxShadow:
                i === 0 ? `0 0 30px ${COLORS.accent}50` : "none",
            }}
          >
            {browser}
          </div>
        ))}
      </div>

      <div
        style={{
          marginTop: 24,
          padding: "18px 44px",
          borderRadius: 16,
          background: COLORS.panel,
          border: `1px solid ${COLORS.border}`,
          opacity: interpolate(localFrame, [60, 72], [0, 1], { extrapolateRight: "clamp" }),
          transform: `scale(${interpolate(localFrame, [60, 72], [0.9, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.back(1.5)) })})`,
        }}
      >
        <div
          style={{
            fontSize: 34,
            fontWeight: 700,
            color: COLORS.text,
            textAlign: "center",
            letterSpacing: "0.02em",
          }}
        >
          無料 / d-op.sasnews.dev
        </div>
      </div>

      <div
        style={{
          marginTop: 16,
          fontSize: 26,
          fontWeight: 700,
          color: COLORS.accent,
          opacity: interpolate(localFrame, [80, 92], [0, 1], { extrapolateRight: "clamp" }),
          transform: `translateY(${interpolate(localFrame, [80, 92], [20, 0], { extrapolateRight: "clamp" })}px)`,
        }}
      >
        #OPスキップ機能要りません
      </div>
    </div>
  );
};
