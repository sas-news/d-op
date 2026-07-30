import React from "react";
import { AbsoluteFill, Audio, staticFile, useCurrentFrame, interpolate, Easing } from "remotion";
import { WIDTH, HEIGHT } from "./constants";
import { HookScene } from "./scenes/HookScene";
import { ProblemScene } from "./scenes/ProblemScene";
import { FeatureScene } from "./scenes/FeatureScene";
import { CtaScene } from "./scenes/CtaScene";

const SceneWrapper: React.FC<{
  from: number;
  duration: number;
  children: React.ReactNode;
}> = ({ from, duration, children }) => {
  const frame = useCurrentFrame();
  const fadeDuration = 10;

  const opacity = interpolate(
    frame,
    [from, from + fadeDuration, from + duration - fadeDuration, from + duration],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.ease }
  );

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity,
        pointerEvents: "none",
      }}
    >
      {children}
    </div>
  );
};

export const PromoVideo: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        width: WIDTH,
        height: HEIGHT,
        background: "#0a0a0c",
      }}
    >
      <Audio src={staticFile("music.mp3")} volume={0.35} />

      <SceneWrapper from={0} duration={45}>
        <HookScene />
      </SceneWrapper>

      <SceneWrapper from={45} duration={60}>
        <ProblemScene />
      </SceneWrapper>

      <SceneWrapper from={105} duration={105}>
        <FeatureScene
          from={105}
          durationInFrames={105}
          step={1}
          title="作品一覧から\nOP/ED を一発再生"
          description="各エピソードに追加された「OP/ED」ボタンで、スキップ区間をそのまま再生。"
          image="store-image1.png"
          imageAlt="作品一覧にOP/EDボタンが追加された様子"
        />
      </SceneWrapper>

      <SceneWrapper from={210} duration={105}>
        <FeatureScene
          from={210}
          durationInFrames={105}
          step={2}
          title="好きなOP/EDを\nプレイリスト化"
          description="劇中歌や変化のあるOPも、好きな範囲を保存して何度でも。"
          image="store-image2.png"
          imageAlt="プレイリストにOP/EDを保存する様子"
        />
      </SceneWrapper>

      <SceneWrapper from={315} duration={105}>
        <FeatureScene
          from={315}
          durationInFrames={105}
          step={3}
          title="複数作品のOP/EDを\n連続再生"
          description="シャッフルや順番入れ替えも。あなただけのOP集を作れる。"
          image="store-image3.png"
          imageAlt="プレイリスト管理画面"
        />
      </SceneWrapper>

      <SceneWrapper from={420} duration={120}>
        <CtaScene />
      </SceneWrapper>
    </AbsoluteFill>
  );
};

