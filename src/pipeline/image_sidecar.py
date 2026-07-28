"""
Local Stable Diffusion sidecar for Ralf's session recaps.

Renders one illustration per scene on the GPU and writes it to disk. Everything
runs locally — no account, no API key, no network at runtime after the one-time
model download.

Only spawned when /ralf-summary needs pictures, and shut down again afterwards:
the model holds most of a 4 GB card, and the bot spends the rest of its life
doing audio.

Protocol
--------
Node -> sidecar (stdin, binary): length-prefixed request frames.
    [uint32 LE total length][uint32 LE request id][utf8 JSON]
    JSON: {"prompt": str, "seed": int|null}

sidecar -> Node (stdout, one JSON object per line, flushed):
    {"type":"ready","model":"stabilityai/sd-turbo","device":"cuda"}
    {"type":"result","id":<id>,"file":"...","ms":1234}
    {"type":"error","id":<id>,"msg":"..."}

Logging goes to stderr so stdout stays pure JSON.
"""

import sys
import os
import json
import time
import struct
import argparse


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="stabilityai/sd-turbo")
    ap.add_argument("--out", required=True, help="directory to write PNGs into")
    ap.add_argument("--steps", type=int, default=4)
    ap.add_argument("--width", type=int, default=512)
    ap.add_argument("--height", type=int, default=512)
    # sd-turbo is a distilled model trained for guidance_scale 0. Raising it
    # does not sharpen the image, it produces burnt-looking output.
    ap.add_argument("--guidance", type=float, default=0.0)
    # Note this does nothing at guidance 0: a negative prompt only has an effect
    # through classifier-free guidance, which is exactly what guidance 0 turns
    # off. Kept for when someone runs a non-distilled model through this sidecar.
    ap.add_argument("--negative", default="")
    # This model's training data was watermarked, and it reproduces a strip of
    # illegible glyphs along the bottom edge. Since the negative prompt cannot
    # reach it, crop it off — 16 px of 512 costs nothing in a printed recap.
    ap.add_argument("--crop-bottom", type=int, default=16)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)

    import torch
    from diffusers import AutoPipelineForText2Image

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32

    try:
        pipe = AutoPipelineForText2Image.from_pretrained(
            args.model,
            torch_dtype=dtype,
            # The 1.x safety checker is a separate ~1.2 GB CLIP model that we
            # cannot afford on a 4 GB card, and it blacks out ordinary D&D
            # combat scenes. Prompts here are machine-written from the table's
            # own recap and the output goes into the group's private PDF.
            safety_checker=None,
            requires_safety_checker=False,
        )
        pipe = pipe.to(device)
        # Measured on the 4 GB 1050 Ti this was written for: a cold card renders
        # 512x512 in ~5.4 s steadily, which is all a five-scene recap needs.
        # Peak allocation is 3.3 GB against 4.0 GB of VRAM, so it fits, but only
        # just — sustained back-to-back rendering pushes reserved memory past the
        # card and the driver's system-memory fallback takes it to ~30 s. Slicing
        # does not prevent that (the weights fill the card, not the activations)
        # and enable_model_cpu_offload() is slower still at ~8.7 s cold, so plain
        # CUDA wins for this burst-shaped workload. Revisit if scenes go up a lot
        # or the resolution does.
        pipe.enable_attention_slicing()
        pipe.vae.enable_slicing()
        pipe.set_progress_bar_config(disable=True)
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "id": 0, "msg": f"model load failed: {e}"})
        log(f"model load failed: {e}")
        sys.exit(1)

    name = torch.cuda.get_device_name(0) if device == "cuda" else "cpu"
    emit({"type": "ready", "model": args.model, "device": device, "gpu": name})
    log(f"ready: model={args.model} device={device} ({name}) steps={args.steps}")

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

        try:
            req = json.loads(payload[4:].decode("utf-8"))
            started = time.time()
            gen = None
            if req.get("seed") is not None:
                gen = torch.Generator(device=device).manual_seed(int(req["seed"]))

            image = pipe(
                prompt=req["prompt"],
                negative_prompt=args.negative or None,
                num_inference_steps=args.steps,
                guidance_scale=args.guidance,
                width=args.width,
                height=args.height,
                generator=gen,
            ).images[0]

            if args.crop_bottom > 0:
                w, h = image.size
                image = image.crop((0, 0, w, h - args.crop_bottom))

            out = os.path.join(args.out, f"scene-{req_id:02d}.png")
            image.save(out)
            emit({"type": "result", "id": req_id, "file": out,
                  "ms": int((time.time() - started) * 1000)})
        except Exception as e:  # noqa: BLE001
            emit({"type": "error", "id": req_id, "msg": str(e)})
            log(f"render {req_id} failed: {e}")


if __name__ == "__main__":
    main()
