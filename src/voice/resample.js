'use strict';

const { Transform } = require('stream');

/**
 * Discord gives 48 kHz stereo signed 16-bit PCM.
 * Porcupine and Whisper both want 16 kHz mono signed 16-bit.
 *
 * Downmix (average the two channels) then decimate 3:1, averaging each group
 * of three samples as a crude low-pass. Good enough for speech; a proper FIR
 * would be better but is not worth the dependency here.
 */
class Downsampler extends Transform {
  constructor(options = {}) {
    super(options);
    // Leftover bytes that didn't form a complete group of 3 stereo frames.
    this._tail = Buffer.alloc(0);
  }

  _transform(chunk, _enc, cb) {
    const buf = this._tail.length ? Buffer.concat([this._tail, chunk]) : chunk;

    // One stereo frame = 4 bytes (2 channels x int16). One output sample
    // consumes 3 stereo frames = 12 bytes.
    const GROUP = 12;
    const groups = Math.floor(buf.length / GROUP);
    const used = groups * GROUP;
    this._tail = buf.subarray(used);

    if (groups === 0) return cb();

    const out = Buffer.alloc(groups * 2);
    for (let g = 0; g < groups; g++) {
      const base = g * GROUP;
      let sum = 0;
      for (let i = 0; i < 3; i++) {
        const off = base + i * 4;
        const l = buf.readInt16LE(off);
        const r = buf.readInt16LE(off + 2);
        sum += (l + r) / 2;
      }
      let v = Math.round(sum / 3);
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      out.writeInt16LE(v, g * 2);
    }
    cb(null, out);
  }

  _flush(cb) {
    this._tail = Buffer.alloc(0);
    cb();
  }
}

/**
 * Split a PCM buffer into fixed-length Int16Array frames.
 * Returns { frames, remainder } — remainder is carried to the next call.
 */
function toFrames(buffer, frameLength) {
  const bytesPerFrame = frameLength * 2;
  const count = Math.floor(buffer.length / bytesPerFrame);
  const frames = [];
  for (let i = 0; i < count; i++) {
    const slice = buffer.subarray(i * bytesPerFrame, (i + 1) * bytesPerFrame);
    const frame = new Int16Array(frameLength);
    for (let j = 0; j < frameLength; j++) frame[j] = slice.readInt16LE(j * 2);
    frames.push(frame);
  }
  return { frames, remainder: buffer.subarray(count * bytesPerFrame) };
}

/** Wrap raw 16 kHz mono PCM in a WAV container. */
function pcmToWav(pcm, sampleRate = 16000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

module.exports = { Downsampler, toFrames, pcmToWav };
