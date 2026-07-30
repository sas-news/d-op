import React from "react";
import { useCurrentFrame, interpolate, Easing } from "remotion";
import { Background } from "../components/Background";
import { AnimatedText } from "../components/AnimatedText";
import { WIDTH, HEIGHT, COLORS } from "../constants";

export const ProblemScene: React.FC = () => {
  const frame = useCurrentFrame();
  const localFrame = frame - 45;

  const lineOpacity = (delay: number) =>
    interpolate(localFrame, [delay, delay + 8], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

  const lineX = (delay: number) =>
    interpolate(
      localFrame,
      [delay, delay + 12],
      [60, 0],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) }
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
        padding: "0 64px",
        gap: 48,
      }}
    >
      <Background />

      <AnimatedText
        from={45}
        style={{
          fontSize: 42,
          fontWeight: 700,
          color: COLORS.textSecondary,
          textAlign: "center",
          letterSpacing: "0.08em",
        }}
      >
        dアニメにOPスキップ機能が来た。
      </AnimatedText>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 24,
          alignItems: "center",
        }}
      >
        {[
          { text: "でも、アニメ好きは", delay: 20, color: COLORS.text, size: 64 },
          { text: "OPを飛ばさない。", delay: 50, color: COLORS.accent, size: 80 },
          { text: "むしろOPだけ見たい。", delay: 80, color: COLORS.text, size: 64 },
        ].map((line, i) => (
          <div
            key={i}
            style={{
              fontSize: line.size,
              fontWeight: 900,
              color: line.color,
              textAlign: "center",
              lineHeight: 1.2,
              opacity: lineOpacity(line.delay),
              transform: `translateX(${lineX(line.delay)}px)`,
              textShadow:
                line.color === COLORS.accent
                  ? `0 0 30px ${COLORS.accent}80`
                  : "none",
            }}
          >
            {line.text}
          </div>
        ))}
      </div>

      <AnimatedText
        from={45}
        delay={110}
        style={{
          fontSize: 30,
          fontWeight: 500,
          color: COLORS.textSecondary,
          textAlign: "center",
          maxWidth: 840,
          lineHeight: 1.6,
        }}
      >
        だから作った。OP/EDだけを自由に再生する拡張機能。
      </AnimatedText>
    </div>
  );
};
