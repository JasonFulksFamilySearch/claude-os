---
name: ffmpeg-reference
description: >
  Quick FFmpeg syntax reference — filter chains, codec presets, quality parameters,
  and hardware acceleration options. Use when needing specific FFmpeg filter syntax,
  codec parameters, encoding presets, or xfade transition syntax.
argument-hint: "(no arguments — reference card)"
allowed-tools: Read
---

<role>
You are the FFmpeg syntax reference card. When loaded, provide the requested
filter syntax or codec parameters from the reference below. For complex pipeline
design or multi-filter chains, delegate to the ffmpeg-expert agent.
</role>

<task>
**Task:** Provide FFmpeg syntax, filter chain examples, and codec parameters on
demand from the reference content below.

**Intent:** Give Willis fast access to FFmpeg syntax without internet lookups or
hallucinating parameter names.

**Hard constraints:**
- Never invent filter parameters — use only what is documented in this card.
- If the requested syntax is not in this card, say so explicitly.
- For complex pipeline design, recommend spawning the ffmpeg-expert subagent.
</task>

<instructions>

# FFmpeg Quick Reference

## Common Filter Chains

### Video Scaling with Letterboxing
```
scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black
```

### Drawtext Title Overlay
```
drawtext=fontfile=/path/to/font.ttf:text='Title':fontsize=80:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2
```

### XFade Transitions
```
[v0][v1]xfade=transition=slideleft:duration=1:offset=10.5[vf1]
```

## Quality Presets

### YouTube-Optimized (1080p)
- Codec: libx264
- CRF: 18 (high quality)
- Preset: slow
- Audio: AAC 320kbps
- Pixel Format: yuv420p

### Fast Encoding
- CRF: 23
- Preset: fast
- Audio: AAC 192kbps

## Codec Selection Guide

- **H.264 (libx264)**: Universal compatibility, YouTube preferred
- **H.265 (libx265)**: Better compression, slower encoding
- **AAC**: Standard audio codec, widely supported
- **VP9**: YouTube alternative, WebM container

## Performance Tips

- Use `-threads N` for multi-core encoding
- Hardware acceleration: `-hwaccel videotoolbox` (macOS)
- Batch processing: Limit concurrent operations to avoid memory issues
- Two-pass encoding for optimal bitrate control

See project FFMPEG_REFERENCE.md for detailed implementation patterns.

</instructions>

<success_criteria>
The skill is complete when:
- The requested filter syntax or codec parameter was provided from this card.
- No filter parameter names were invented — only documented values used.
- If the syntax wasn't in this card, that was stated explicitly.
</success_criteria>

<examples>
<example label="filter-lookup">
Input: /ffmpeg-reference xfade syntax

Provided: [v0][v1]xfade=transition=slideleft:duration=1:offset=10.5[vf1]
</example>

<example label="not-in-card">
Input: /ffmpeg-reference audio loudnorm parameters

"loudnorm parameters are not in this reference card. For detailed filter options, spawn the ffmpeg-expert subagent."
</example>
</examples>
