# 实时调度录屏

`live-flow-demo.svg` 来自用户提供的 `录屏2026-09-17 19.41.19.mov`，用于中英文 README。

- 原片：1462 × 1046，约 4.13 秒。
- 展示：1200 × 858，12 fps，共 49 帧，循环约 4.08 秒。
- SVG 内嵌 WebP 栅格帧，以声明式 SMIL 动画切换；没有 JavaScript、外部图片依赖或音频，不属于视频矢量化。
- 不支持动画时显示首帧；包含减少动态效果的媒体查询，在支持向 SVG 传递该偏好的查看器中显示首帧。
- 转换工具依赖 `ffmpeg`、`ffprobe`、`cwebp` 和 Python 3。

在仓库根目录重新生成：

```bash
python3 scripts/recording-to-svg.py /path/to/recording.mov docs/images/live-flow-demo.svg
```

可通过 `--width`、`--fps` 调整尺寸和帧率。原始录屏没有复制进仓库。
