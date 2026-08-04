// ---------------------------------------------------------------------------
// Mu-law WAV container.
//
// Extracted from scripts/voice-ab.js so the blind A/B harness writes byte-
// identical files to the ones that script already produces — a listening pack
// that differed in container framing from the reference tool would be one more
// thing to rule out when a clip sounds wrong.
//
// Format 7 (ITU G.711 mu-law) with a `fact` chunk, which non-PCM WAV requires.
// ---------------------------------------------------------------------------

/**
 * Wrap 8kHz mono mu-law bytes in a WAV container.
 * @param {Buffer} mulaw - raw mu-law samples, 1 byte each
 * @returns {Buffer}
 */
export function mulawToWav(mulaw) {
  const sampleRate = 8000;
  const header = Buffer.alloc(58);
  let o = 0;
  header.write("RIFF", o); o += 4;
  header.writeUInt32LE(50 + mulaw.length, o); o += 4; // file size - 8
  header.write("WAVE", o); o += 4;
  header.write("fmt ", o); o += 4;
  header.writeUInt32LE(18, o); o += 4;            // fmt chunk size (18 for non-PCM)
  header.writeUInt16LE(7, o); o += 2;             // audioFormat 7 = mu-law
  header.writeUInt16LE(1, o); o += 2;             // channels
  header.writeUInt32LE(sampleRate, o); o += 4;    // sample rate
  header.writeUInt32LE(sampleRate, o); o += 4;    // byte rate (blockAlign * rate)
  header.writeUInt16LE(1, o); o += 2;             // block align
  header.writeUInt16LE(8, o); o += 2;             // bits per sample
  header.writeUInt16LE(0, o); o += 2;             // cbSize
  header.write("fact", o); o += 4;
  header.writeUInt32LE(4, o); o += 4;             // fact chunk size
  header.writeUInt32LE(mulaw.length, o); o += 4;  // samples
  header.write("data", o); o += 4;
  header.writeUInt32LE(mulaw.length, o); o += 4;
  return Buffer.concat([header, mulaw]);
}
