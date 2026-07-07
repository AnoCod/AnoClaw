---
name: video-production
description: "Create programmatic video with Remotion (React -> MP4), Manim (math animations), and FFmpeg (post-processing). Use for marketing videos, product demos, educational content, social media clips, and data visualizations."
when_to_use: "User wants to create a video, animate something, make a product demo, render a presentation as video, or generate social media clips."
triggers:
  - "video"
  - "animate"
  - "render"
  - "MP4"
  - "demo"
  - "clip"
  - "social media"
  - "tiktok"
  - "reel"
  - "explainer"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
---

# Video Production

## Agent Handoff

- Use this skill only when its `when_to_use` guidance matches the assigned task.
- If you are a child agent, keep the skill output focused on the parent assignment and report verification or blockers clearly.
- Do not override higher-priority system, permission, or delegation rules.

Create professional videos programmatically. Write code -> render MP4. No timeline editor needed.

## Tool Selection

| Tool | Best For |
|------|----------|
| **Remotion** (React) | Marketing videos, product demos, branded content, social clips |
| **Manim** (Python) | Math/science animations, educational content, diagrams |
| **FFmpeg** (CLI) | Trimming, concatenation, format conversion, post-processing |

## Remotion Quick Start

```bash
npx create-video@latest my-video
cd my-video
npm install
```

Basic composition:
```tsx
import { Composition, useCurrentFrame, interpolate, spring, Sequence } from 'remotion';

export const MyVideo: React.FC = () => {
  return (
    <Composition id="MyVideo" component={MainScene} durationInFrames={300} fps={30} width={1920} height={1080} />
  );
};

const MainScene: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 30], [0, 1]);
  const scale = spring({ frame, fps: 30, config: { damping: 200 } });
  
  return <div style={{ opacity, transform: `scale(${scale})` }}>Hello World</div>;
};
```

## Frame-Based Animation Principles

1. **Everything is a function of `frame`** - no CSS transitions, no `animate-*` Tailwind classes
2. **`interpolate(frame, [inputRange], [outputRange])`** - map frames to any value
3. **`spring({ frame, fps, config })`** - natural physics-based motion
4. **`<Sequence from={30} durationInFrames={90}>`** - sequence clips in timeline

## Platform-Specific Outputs

| Platform | Resolution | Duration | Style |
|----------|-----------|----------|-------|
| YouTube | 1920×1080 | 3-15 min | Horizontal, chapters |
| TikTok | 1080×1920 | 15-60 sec | Vertical, captions required |
| Instagram Reel | 1080×1920 | 15-90 sec | Vertical, trending audio |
| YouTube Shorts | 1080×1920 | 15-60 sec | Vertical, hooks first 3 sec |

## Manim (Math/Science Animations)

```python
from manim import *
class MyScene(Scene):
    def construct(self):
        circle = Circle(color=BLUE, fill_opacity=0.5)
        square = Square(color=RED, fill_opacity=0.5)
        self.play(Create(circle))
        self.play(Transform(circle, square))
        self.wait()
```

## FFmpeg Post-Processing

```bash
# Trim video
ffmpeg -i input.mp4 -ss 00:01:30 -to 00:03:00 -c copy trimmed.mp4

# Add audio
ffmpeg -i video.mp4 -i audio.mp3 -c:v copy -c:a aac -shortest output.mp4

# Resize for social
ffmpeg -i input.mp4 -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" output.mp4

# Concatenate clips
ffmpeg -f concat -safe 0 -i files.txt -c copy merged.mp4
```

## Production Pipeline

1. **Script** - Write the narration/text
2. **Storyboard** - Plan scenes, timing, transitions
3. **Assets** - Create/gather images, icons, fonts, audio
4. **Animate** - Build Remotion components with frame-based timing
5. **Render** - `npx remotion render MyVideo output.mp4`
6. **QC** - Check frame-by-frame, verify audio sync
7. **Post-Process** - FFmpeg for compression, audio normalization, platform packaging
