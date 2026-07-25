"""
openWakeWord sidecar for Ralf.

The Node bot pipes per-speaker 16 kHz mono 16-bit PCM to this process and reads
back detections. Everything runs locally — no account, no network at runtime.

Protocol
--------
Node -> sidecar (stdin, binary): length-prefixed frames.
    [uint32 LE payload length][payload]
    payload[0] = opcode:
      1 OPEN  : [1][uint16 LE streamId]              start a detector for a speaker
      2 AUDIO : [2][uint16 LE streamId][int16 LE PCM] feed audio for a speaker
      3 CLOSE : [3][uint16 LE streamId]              release a speaker's detector

sidecar -> Node (stdout, one JSON object per line, flushed):
    {"type":"ready","model":"alexa","threshold":0.5}
    {"type":"detect","stream":<id>,"model":"alexa","score":0.83}
    {"type":"error","msg":"..."}

Logging goes to stderr so stdout stays pure JSON.
"""

import sys
import os
import json
import struct
import argparse

import numpy as np

# openWakeWord chews 16 kHz mono int16 audio; 80 ms (1280 samples) per predict.
CHUNK = 1280
# After a hit, ignore this many samples on that stream so one utterance fires once.
REFRACTORY_SAMPLES = 16000 * 1  # ~1 s; Node applies a longer cooldown on top.

OP_OPEN, OP_AUDIO, OP_CLOSE = 1, 2, 3

# Diagnostic: with OWW_TRACE=1, log every chunk's best score above a floor to
# stderr (shows up as [oww] debug lines) so thresholds can be tuned.
TRACE = os.environ.get("OWW_TRACE") == "1"
TRACE_FLOOR = float(os.environ.get("OWW_TRACE_FLOOR", "0.02"))


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def read_exact(stream, n):
    """Read exactly n bytes or return None on EOF."""
    buf = bytearray()
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


class Detector:
    """One openWakeWord model instance plus this speaker's rolling buffer."""

    def __init__(self, make_model):
        self.model = make_model()
        self.buf = np.zeros(0, dtype=np.int16)
        self.refractory = 0

    def feed(self, pcm):
        """Feed int16 PCM; yield (model_name, score) for each detection."""
        self.buf = np.concatenate([self.buf, pcm]) if self.buf.size else pcm
        hits = []
        while self.buf.size >= CHUNK:
            frame = self.buf[:CHUNK]
            self.buf = self.buf[CHUNK:]
            if self.refractory > 0:
                self.refractory -= CHUNK
                continue
            scores = self.model.predict(frame)
            best_name, best_score = None, 0.0
            for name, score in scores.items():
                if score > best_score:
                    best_name, best_score = name, float(score)
            hits.append((best_name, best_score))
        return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True,
                    help="builtin name (e.g. alexa) or path to a .onnx/.tflite model")
    ap.add_argument("--threshold", type=float, default=0.5)
    args = ap.parse_args()

    from openwakeword.model import Model

    model_arg = args.model
    # A path to a real file is a custom model; otherwise treat as a builtin name.
    is_path = os.path.exists(model_arg)

    def make_model():
        return Model(wakeword_models=[model_arg], inference_framework="onnx")

    # Build one up front to fail fast and report the resolved model name.
    try:
        probe = make_model()
        model_name = list(probe.models.keys())[0]
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "msg": f"failed to load model '{model_arg}': {e}"})
        log(f"model load failed: {e}")
        sys.exit(1)

    emit({"type": "ready", "model": model_name, "threshold": args.threshold,
          "custom": bool(is_path)})
    log(f"ready: model={model_name} threshold={args.threshold} custom={is_path}")

    streams = {}
    stdin = sys.stdin.buffer

    while True:
        header = read_exact(stdin, 4)
        if header is None:
            break
        (length,) = struct.unpack("<I", header)
        payload = read_exact(stdin, length)
        if payload is None:
            break

        op = payload[0]
        if op == OP_OPEN:
            (sid,) = struct.unpack("<H", payload[1:3])
            if sid not in streams:
                try:
                    streams[sid] = Detector(make_model)
                    log(f"open stream {sid} ({len(streams)} active)")
                except Exception as e:  # noqa: BLE001
                    emit({"type": "error", "msg": f"open {sid} failed: {e}"})
        elif op == OP_AUDIO:
            (sid,) = struct.unpack("<H", payload[1:3])
            det = streams.get(sid)
            if det is None:
                continue
            pcm = np.frombuffer(payload[3:], dtype="<i2")
            for name, score in det.feed(pcm):
                if TRACE and score >= TRACE_FLOOR:
                    log(f"trace stream={sid} {name} score={score:.3f}")
                if score >= args.threshold:
                    det.refractory = REFRACTORY_SAMPLES
                    emit({"type": "detect", "stream": sid,
                          "model": name, "score": round(score, 3)})
        elif op == OP_CLOSE:
            (sid,) = struct.unpack("<H", payload[1:3])
            if streams.pop(sid, None) is not None:
                log(f"close stream {sid}")


if __name__ == "__main__":
    main()
