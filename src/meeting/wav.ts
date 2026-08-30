/** Wrap raw mono PCM16LE samples in a minimal WAV (RIFF) header — OpenAI's
 * transcription endpoint wants a file, not a raw stream. No library needed;
 * a WAV header is 44 fixed bytes. */
export function pcm16leToWav(pcm: Buffer, sampleRate: number): Buffer {
	const header = Buffer.alloc(44);
	const dataSize = pcm.length;
	const byteRate = sampleRate * 2; // mono, 16-bit
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + dataSize, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16); // fmt chunk size
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(2, 32); // block align
	header.writeUInt16LE(16, 34); // bits per sample
	header.write("data", 36, "ascii");
	header.writeUInt32LE(dataSize, 40);
	return Buffer.concat([header, pcm]);
}

/** RMS of a mono PCM16LE buffer, normalized to [0, 1]. */
export function pcm16leRms(pcm: Buffer): number {
	const samples = pcm.length / 2;
	if (samples === 0) return 0;
	let sumSquares = 0;
	for (let i = 0; i < pcm.length; i += 2) {
		const sample = pcm.readInt16LE(i) / 32768;
		sumSquares += sample * sample;
	}
	return Math.sqrt(sumSquares / samples);
}
