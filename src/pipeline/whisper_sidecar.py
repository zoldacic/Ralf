"""
Local Whisper STT sidecar for Ralf (faster-whisper).

Keeps the model loaded so each transcription is just inference — no per-call
reload. Everything runs locally: no account, no API key, no network at runtime
(after the one-time model download). Replaces the OpenAI transcription call.

Protocol
--------
Node -> sidecar (stdin, binary): length-prefixed request frames.
    [uint32 LE total length][uint32 LE request id][WAV bytes]

sidecar -> Node (stdout, one JSON object per line, flushed):
    {"type":"ready","model":"small"}
    {"type":"result","id":<id>,"text":"..."}
    {"type":"error","id":<id>,"msg":"..."}

Logging goes to stderr so stdout stays pure JSON.
"""

import sys
import json
import struct
import argparse

import numpy as np


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def read_exact(stream, n):
    buf = bytearray()
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


def wav_to_float32(b):
    """Extract 16 kHz mono PCM from a WAV and normalize to float32 [-1, 1]."""
    pcm = None
    if b[:4] == b"RIFF" and b[8:12] == b"WAVE":
        i = 12
        while i + 8 <= len(b):
            chunk_id = b[i:i + 4]
            (size,) = struct.unpack("<I", b[i + 4:i + 8])
            if chunk_id == b"data":
                pcm = b[i + 8:i + 8 + size]
                break
            i += 8 + size + (size & 1)  # chunks are word-aligned
    if pcm is None:
        pcm = b[44:]  # fall back to a standard 44-byte header
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="small")
    ap.add_argument("--language", default="en")
    ap.add_argument("--compute-type", default="int8")
    ap.add_argument("--initial-prompt", default="")
    ap.add_argument("--beam-size", type=int, default=5)
    args = ap.parse_args()

    from faster_whisper import WhisperModel

    try:
        model = WhisperModel(args.model, device="cpu", compute_type=args.compute_type)
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "id": 0, "msg": f"model load failed: {e}"})
        log(f"model load failed: {e}")
        sys.exit(1)

    emit({"type": "ready", "model": args.model})
    log(f"ready: model={args.model} lang={args.language} compute={args.compute_type}")

    stdin = sys.stdin.buffer
    while True:
        header = read_exact(stdin, 4)
        if header is None:
            break
        (length,) = struct.unpack("<I", header)
        payload = read_exact(stdin, length)
        if payload is None:
            break
        (req_id,) = struct.unpack("<I", payload[:4])
        wav = payload[4:]

        try:
            audio = wav_to_float32(wav)
            segments, _info = model.transcribe(
                audio,
                language=args.language,
                initial_prompt=args.initial_prompt or None,
                beam_size=args.beam_size,
                condition_on_previous_text=False,  # avoids hallucination loops
                no_speech_threshold=0.6,
                vad_filter=True,  # drop silence — faster and cleaner
                vad_parameters={"min_silence_duration_ms": 500},
            )
            # Drop low-confidence / silence segments so noise doesn't come back
            # as a Whisper hallucination ("thanks for watching", etc.).
            kept = [
                seg.text for seg in segments
                if seg.no_speech_prob < 0.6 and seg.avg_logprob > -1.0
            ]
            text = " ".join(kept).strip()
            emit({"type": "result", "id": req_id, "text": text})
        except Exception as e:  # noqa: BLE001
            emit({"type": "error", "id": req_id, "msg": str(e)})
            log(f"transcribe {req_id} failed: {e}")


if __name__ == "__main__":
    main()
