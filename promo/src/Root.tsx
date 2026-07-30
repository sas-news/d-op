import "./index.css";
import { Composition } from "remotion";
import { PromoVideo } from "./PromoVideo";
import { WIDTH, HEIGHT, FPS, DURATION_IN_FRAMES } from "./constants";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="PromoVideo"
        component={PromoVideo}
        durationInFrames={DURATION_IN_FRAMES}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        defaultProps={{}}
      />
    </>
  );
};

