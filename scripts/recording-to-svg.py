#!/usr/bin/env python3
"""Convert a short screen recording to a self-contained, script-free animated SVG.

Requires ffmpeg, ffprobe and cwebp. Raster frames are embedded as WebP; this does not vectorize video.
Usage: python3 scripts/recording-to-svg.py recording.mov docs/images/live-flow-demo.svg
"""
import argparse
import base64
import json
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("input", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--width", type=int, default=1200)
parser.add_argument("--fps", type=int, default=12)
args = parser.parse_args()
if args.width <= 0 or args.fps <= 0:
    parser.error("width and fps must be positive")
with tempfile.TemporaryDirectory(prefix="recording-svg-") as temporary:
    subprocess.run([
        "ffmpeg", "-v", "error", "-i", str(args.input), "-an",
        "-vf", f"fps={args.fps},scale={args.width}:-2:flags=lanczos",
        str(Path(temporary) / "frame-%04d.png"),
    ], check=True)
    for frame in sorted(Path(temporary).glob("frame-*.png")):
        subprocess.run(["cwebp", "-quiet", "-q", "85", "-m", "6", str(frame), "-o", str(frame.with_suffix(".webp"))], check=True)
    frames = sorted(Path(temporary).glob("frame-*.webp"))
    if not frames:
        raise RuntimeError("No video frames decoded")
    info = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "stream=width,height",
        "-of", "json", str(frames[0]),
    ]))["streams"][0]
    width, height = info["width"], info["height"]
    data = ["data:image/webp;base64," + base64.b64encode(p.read_bytes()).decode("ascii") for p in frames]
    duration = len(frames) / args.fps
    svg = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc">',
        '<title id="title">Navo — live gateway flow</title>',
        '<desc id="desc">Screen recording of the dark dashboard. Cyan connections show uploads; purple connections show responses. Embedded raster frames, not vectorized artwork.</desc>',
        '<style>@media (prefers-reduced-motion: reduce) { .frame { display: none; } }</style>',
        f'<image width="{width}" height="{height}" href="{data[0]}"/>',
    ]
    # The first frame remains visible as a fallback. Only one later frame overlays it
    # at a time; SMIL discrete timing also works when the SVG is loaded through img.
    for i, uri in enumerate(data[1:], 1):
        start, end = i / len(frames), (i + 1) / len(frames)
        times = f"0;{start:.9f};1" if i == len(frames) - 1 else f"0;{start:.9f};{end:.9f};1"
        values = "0;1;0" if i == len(frames) - 1 else "0;1;0;0"
        svg.append(f'<image class="frame" width="{width}" height="{height}" href="{uri}" opacity="0"><animate attributeName="opacity" values="{values}" keyTimes="{times}" calcMode="discrete" dur="{duration:.9f}s" repeatCount="indefinite"/></image>')
    svg.append('</svg>')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("\n".join(svg) + "\n")
    print(f"{args.output}: {len(frames)} frames, {duration:.2f}s, {width}x{height}, {args.output.stat().st_size / 1048576:.2f} MiB")
