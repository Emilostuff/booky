#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["fastapi", "uvicorn", "numpy", "static-ffmpeg"]
# ///
"""booky - fetch an audiobook HLS stream, find the pauses, chop it into chapters."""

import json
import os
import re
import shutil
import subprocess
import threading
import uuid
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
PROJECTS = ROOT / "projects"
STATIC = ROOT / "static"
PORT = 8765
PEAKS_PER_SEC = 100
MARKER_BACKOFF = 0.2     # place a split this many seconds before speech resumes
DEFAULT_GAP = 2.0        # seconds of silence that counts as a chapter break
DEFAULT_NOISE = -35.0    # dB below which audio counts as silence

app = FastAPI()
app.mount("/static", StaticFiles(directory=STATIC), name="static")
JOBS: dict[str, dict] = {}


# ---------------------------------------------------------------- project i/o

def safe_name(name: str) -> str:
    name = re.sub(r"[^A-Za-z0-9._ æøåÆØÅ-]+", "", (name or "").strip()).strip(" .")
    if not name:
        raise HTTPException(400, "invalid name")
    return name


def pdir(name: str) -> Path:
    return PROJECTS / safe_name(name)


def source_dir(name: str) -> Path:
    return pdir(name) / "source"


def output_dir(name: str) -> Path:
    return pdir(name) / "output"


def source_file(name: str) -> Path:
    return source_dir(name) / "source.aac"


def master(name: str) -> Path:
    """Cutting/analysis master. Raw ADTS has no timestamp index, so its header
    duration is a bitrate guess and seeks land seconds off; the remuxed mp4 is exact."""
    return source_dir(name) / "master.m4a"


def peaks_file(name: str) -> Path:
    return source_dir(name) / "peaks.bin"


def meta_path(name: str) -> Path:
    return pdir(name) / "project.json"


def empty_meta(name: str) -> dict:
    return {"name": name, "url": None, "fetched_at": None, "duration": None,
            "gap": DEFAULT_GAP, "noise": DEFAULT_NOISE, "splits": [], "chapters": []}


def load_meta(name: str) -> dict:
    if not pdir(name).is_dir():
        raise HTTPException(404, f"no project named {name!r}")
    p = meta_path(name)
    meta = empty_meta(safe_name(name))
    if p.exists():
        meta.update(json.loads(p.read_text()))
    return meta


def save_meta(name: str, meta: dict) -> None:
    pdir(name).mkdir(parents=True, exist_ok=True)
    meta_path(name).write_text(json.dumps(meta, indent=2, ensure_ascii=False))


def analyzed(name: str) -> bool:
    return master(name).exists() and peaks_file(name).exists() and \
        load_meta(name).get("duration") is not None


def describe(name: str) -> dict:
    meta = load_meta(name)
    meta["has_source"] = source_file(name).exists()
    meta["analyzed"] = analyzed(name)
    out = output_dir(name)
    meta["exported"] = sorted(p.name for p in out.glob("*.aac")) if out.exists() else []
    return meta


# ------------------------------------------------------------------- ffmpeg

def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True)


def duration_of(path: str | Path) -> float | None:
    r = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(path)])
    try:
        return float(r.stdout.strip())
    except ValueError:
        return None


def fmt_time(t: float) -> str:
    t = max(0, int(t))
    h, m, s = t // 3600, t // 60 % 60, t % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def download(url: str, dest: Path, log) -> None:
    """Stream-copy the HLS audio to a raw ADTS file, reporting progress."""
    total = duration_of(url)
    proc = subprocess.Popen(
        ["ffmpeg", "-y", "-v", "error", "-nostats", "-progress", "pipe:1",
         "-i", url, "-vn", "-c", "copy", str(dest)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    for line in proc.stdout:
        if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
            try:
                done = int(line.split("=", 1)[1]) / 1_000_000
            except ValueError:
                continue
            suffix = f" / {fmt_time(total)}" if total else ""
            log(f"downloading {fmt_time(done)}{suffix}")
    proc.wait()
    err = proc.stderr.read()
    if proc.returncode != 0 or not dest.exists() or dest.stat().st_size == 0:
        raise RuntimeError("download failed:\n" + err.strip()[-800:])


def compute_peaks(src: Path, duration: float) -> bytes:
    """Decode to a low-rate mono stream and reduce it to one amplitude byte per bucket."""
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(src), "-ac", "1", "-ar", "8000",
         "-f", "s16le", "-"],
        capture_output=True,
    )
    samples = np.frombuffer(r.stdout, dtype=np.int16)
    if samples.size == 0:
        raise RuntimeError(f"no audio decoded: {r.stderr.decode()[:400]}")
    n = max(1, int(duration * PEAKS_PER_SEC))
    per = max(1, samples.size // n)
    n = max(1, samples.size // per)
    block = np.abs(samples[: per * n].reshape(n, per).astype(np.int32)).max(axis=1)
    top = max(1, int(block.max()))
    return (block * 255 // top).astype(np.uint8).tobytes()


def detect_splits(src: Path, duration: float, gap: float, noise: float) -> list[float]:
    """Return one split per silence, sitting just before speech starts again."""
    r = subprocess.run(
        ["ffmpeg", "-v", "info", "-nostats", "-i", str(src),
         "-af", f"silencedetect=noise={noise}dB:d={gap}", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    splits, start = [], None
    for line in r.stderr.splitlines():
        if m := re.search(r"silence_start:\s*(-?[\d.]+)", line):
            start = float(m.group(1))
        elif m := re.search(r"silence_end:\s*(-?[\d.]+)", line):
            end = float(m.group(1))
            lo = (start if start is not None else end) + 0.05
            splits.append(max(lo, end - MARKER_BACKOFF))
            start = None
    return [round(t, 3) for t in splits if 1.0 < t < duration - 1.0]


def analyze(name: str, log) -> dict:
    """Build master + peaks from source.aac, run default detection, save."""
    src = source_file(name)
    if not src.exists():
        raise RuntimeError("no source audio to analyze")

    log("indexing audio...")
    r = run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-c", "copy", str(master(name))])
    if r.returncode != 0:
        raise RuntimeError("remux failed:\n" + r.stderr.strip()[-800:])

    log("scanning waveform...")
    duration = duration_of(master(name))
    if duration is None:
        raise RuntimeError("could not read duration of master")
    peaks_file(name).write_bytes(compute_peaks(master(name), duration))

    log("finding pauses...")
    meta = load_meta(name)
    splits = detect_splits(master(name), duration, DEFAULT_GAP, DEFAULT_NOISE)
    bounds = [0.0] + splits + [duration]
    meta.update(
        duration=duration, gap=DEFAULT_GAP, noise=DEFAULT_NOISE, splits=splits,
        chapters=[{"name": None, "start": bounds[i], "end": bounds[i + 1]}
                  for i in range(len(bounds) - 1)],
    )
    save_meta(name, meta)
    return {"name": name}


# --------------------------------------------------------------------- jobs

def start_job(fn) -> str:
    jid = uuid.uuid4().hex[:12]
    JOBS[jid] = {"state": "running", "log": "", "result": None}

    def wrapper():
        try:
            JOBS[jid]["result"] = fn(lambda m: JOBS[jid].update(log=m))
            JOBS[jid]["state"] = "done"
        except Exception as exc:  # surfaced verbatim in the UI
            JOBS[jid]["state"] = "error"
            JOBS[jid]["log"] = str(exc)

    threading.Thread(target=wrapper, daemon=True).start()
    return jid


@app.get("/api/job/{jid}")
def job_status(jid: str):
    if jid not in JOBS:
        raise HTTPException(404, "unknown job")
    return JOBS[jid]


# ------------------------------------------------------------------ routes

@app.get("/", response_class=HTMLResponse)
def index():
    return (STATIC / "index.html").read_text()


@app.get("/api/projects")
def list_projects():
    if not PROJECTS.exists():
        return []
    items = []
    for p in sorted(PROJECTS.iterdir(), key=lambda p: p.name.lower()):
        if not p.is_dir() or p.name.startswith("."):
            continue
        meta = load_meta(p.name)
        items.append({"name": p.name, "duration": meta.get("duration"),
                      "has_source": source_file(p.name).exists(),
                      "analyzed": analyzed(p.name)})
    return items


@app.post("/api/projects")
async def create_project(request: Request):
    body = await request.json()
    name = safe_name(body.get("name", ""))
    if pdir(name).exists():
        raise HTTPException(409, f"a project named {name!r} already exists")
    save_meta(name, empty_meta(name))
    return describe(name)


@app.get("/api/projects/{name}")
def get_project(name: str):
    return describe(name)


@app.delete("/api/projects/{name}")
def delete_project(name: str):
    d = pdir(name)
    if not d.is_dir():
        raise HTTPException(404, "no such project")
    shutil.rmtree(d)
    return {"ok": True}


@app.post("/api/projects/{name}/fetch")
async def fetch(name: str, request: Request):
    body = await request.json()
    name = safe_name(name)
    url = (body.get("url") or "").strip()
    if not url:
        raise HTTPException(400, "a url is required")
    load_meta(name)

    def work(log):
        sd = source_dir(name)
        shutil.rmtree(sd, ignore_errors=True)
        sd.mkdir(parents=True, exist_ok=True)
        download(url, source_file(name), log)
        meta = load_meta(name)
        meta.update(url=url, fetched_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
        save_meta(name, meta)
        return analyze(name, log)

    return {"job": start_job(work)}


@app.post("/api/projects/{name}/analyze")
def reanalyze(name: str):
    name = safe_name(name)
    if not source_file(name).exists():
        raise HTTPException(400, "no source audio")
    return {"job": start_job(lambda log: analyze(name, log))}


@app.post("/api/projects/{name}/detect")
async def detect(name: str, request: Request):
    body = await request.json()
    name = safe_name(name)
    meta = load_meta(name)
    if not analyzed(name):
        raise HTTPException(400, "project not analyzed")
    gap = float(body.get("gap", meta["gap"]))
    noise = float(body.get("noise", meta["noise"]))
    return {"splits": detect_splits(master(name), meta["duration"], gap, noise)}


@app.get("/api/projects/{name}/peaks")
def peaks(name: str):
    p = peaks_file(name)
    if not p.exists():
        raise HTTPException(404, "no peaks")
    return Response(p.read_bytes(), media_type="application/octet-stream",
                    headers={"X-Peaks-Per-Sec": str(PEAKS_PER_SEC)})


def chapter_filename(raw: str | None, index: int, used: set[str]) -> str:
    base = re.sub(r"\.aac$", "", (raw or "").strip(), flags=re.I)
    base = re.sub(r"[/\\:]+", "-", base).strip(" .") or f"chapter{index}"
    cand, n = base, 2
    while cand.lower() in used:
        cand = f"{base} {n}"
        n += 1
    used.add(cand.lower())
    return f"{cand}.aac"


@app.post("/api/projects/{name}/export")
async def export(name: str, request: Request):
    body = await request.json()
    name = safe_name(name)
    meta = load_meta(name)
    if not analyzed(name):
        raise HTTPException(400, "project not analyzed")
    duration = meta["duration"]

    splits = sorted(round(float(t), 3) for t in body.get("splits", []))
    chapters = body.get("chapters", [])
    if len(chapters) != len(splits) + 1:
        raise HTTPException(400, "chapters do not match splits")
    bounds = [0.0] + splits + [duration]
    clean = []
    for i, ch in enumerate(chapters):
        lo, hi = bounds[i], bounds[i + 1]
        s = min(max(float(ch.get("start", lo)), lo), hi)
        e = min(max(float(ch.get("end", hi)), lo), hi)
        if e - s < 0.1:
            raise HTTPException(400, f"chapter {i + 1} is too short")
        clean.append({"name": (ch.get("name") or None), "start": round(s, 3), "end": round(e, 3)})

    meta.update(gap=float(body.get("gap", meta["gap"])), noise=float(body.get("noise", meta["noise"])),
                splits=splits, chapters=clean)
    src, dest = master(name), output_dir(name)

    def work(log):
        shutil.rmtree(dest, ignore_errors=True)
        dest.mkdir(parents=True)
        used: set[str] = set()
        for i, ch in enumerate(clean):
            fname = chapter_filename(ch["name"], i + 1, used)
            log(f"writing {fname} ({i + 1} of {len(clean)})...")
            r = run(["ffmpeg", "-y", "-v", "error", "-i", str(src),
                     "-ss", f"{ch['start']:.3f}", "-to", f"{ch['end']:.3f}",
                     "-c", "copy", "-f", "adts", str(dest / fname)])
            if r.returncode != 0:
                raise RuntimeError(f"{fname} failed:\n" + r.stderr.strip()[-500:])
        save_meta(name, meta)
        return {"count": len(clean), "folder": str(dest)}

    return {"job": start_job(work)}


@app.post("/api/projects/{name}/reveal")
def reveal(name: str):
    d = output_dir(name) if output_dir(name).exists() else pdir(name)
    subprocess.run(["open", str(d)])
    return {"ok": True}


@app.get("/api/projects/{name}/audio")
def audio(name: str, request: Request):
    path = master(name)
    if not path.exists():
        raise HTTPException(404, "no audio")
    size = path.stat().st_size
    rng = request.headers.get("range")
    if not rng:
        return FileResponse(path, media_type="audio/mp4")

    m = re.match(r"bytes=(\d*)-(\d*)", rng)
    start = int(m.group(1)) if m and m.group(1) else 0
    end = int(m.group(2)) if m and m.group(2) else size - 1
    end = min(end, size - 1)
    length = max(0, end - start + 1)

    def stream():
        with path.open("rb") as fh:
            fh.seek(start)
            left = length
            while left > 0:
                chunk = fh.read(min(262144, left))
                if not chunk:
                    break
                left -= len(chunk)
                yield chunk

    return StreamingResponse(stream(), status_code=206, media_type="audio/mp4", headers={
        "Content-Range": f"bytes {start}-{end}/{size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
    })


# ------------------------------------------------------------------- main

def ensure_ffmpeg() -> None:
    if shutil.which("ffmpeg") and shutil.which("ffprobe"):
        return
    print("ffmpeg not found on PATH, using bundled static build (first run downloads it)...")
    import static_ffmpeg
    static_ffmpeg.add_paths()


if __name__ == "__main__":
    ensure_ffmpeg()
    PROJECTS.mkdir(exist_ok=True)
    if not os.environ.get("BOOKY_NO_BROWSER"):
        threading.Timer(1.0, lambda: webbrowser.open(f"http://127.0.0.1:{PORT}")).start()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
