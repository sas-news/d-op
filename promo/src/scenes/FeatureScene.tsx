import React from "react";
import { useCurrentFrame, interpolate, Easing } from "remotion";
import { Background } from "../components/Background";
import { AnimatedText } from "../components/AnimatedText";
import { ImageCard } from "../components/ImageCard";
import { WIDTH, HEIGHT, COLORS } from "../constants";

type FeatureSceneProps = {
  from: number;
  durationInFrames: number;
  step: number;
  title: string;
  description: string;
  image: string;
  imageAlt: string;
};

export const FeatureScene: React.FC<FeatureSceneProps> = ({
  from,
  durationInFrames,
  step,
  title,
  description,
  image,
  imageAlt,
}) => {
  const frame = useCurrentFrame();
  const localFrame = frame - from;
  const end = durationInFrames;

  const progress = interpolate(
    localFrame,
    [end - 15, end],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.cubic) }
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
        justifyContent: "flex-start",
        paddingTop: 120,
        gap: 40,
        transform: `translateY(${-progress * 80}px)`,
        opacity: interpolate(localFrame, [0, 8], [0, 1], { extrapolateRight: "clamp" }),
      }}
    >
      <Background />

      <AnimatedText
        from={from}
        style={{
          fontSize: 38,
          fontWeight: 900,
          color: COLORS.accent,
          letterSpacing: "0.12em",
          background: "rgba(230,0,18,0.12)",
          padding: "10px 24px",
          borderRadius: 999,
          border: `1px solid ${COLORS.accent}30`,
        }}
      >
        FEATURE 0{step}
      </AnimatedText>

      <AnimatedText
        from={from}
        delay={8}
        style={{
          fontSize: 56,
          fontWeight: 900,
          color: COLORS.text,
          textAlign: "center",
          lineHeight: 1.25,
          maxWidth: 900,
        }}
      >
        {title}
      </AnimatedText>

      <div style={{ marginTop: 8 }}>
        <ImageCard src={image} from={from + 12} alt={imageAlt} />
      </div>

      <AnimatedText
        from={from}
        delay={30}
        style={{
          fontSize: 34,
          fontWeight: 500,
          color: COLORS.textSecondary,
          textAlign: "center",
          maxWidth: 860,
          lineHeight: 1.5,
        }}
      >
        {description}
      </AnimatedText>
    </div>
  );
};
