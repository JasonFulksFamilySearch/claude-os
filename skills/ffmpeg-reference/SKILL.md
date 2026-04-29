---
name: ffmpeg-reference
description: Quick FFmpeg syntax reference and filter examples. Use when needing specific filter syntax or codec parameters.
disable-model-invocation: false
allowed-tools: Read
---

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
