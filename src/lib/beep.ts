/**
 * Short scan beep for continuous mode. The WAV is synthesized at runtime (no media files in the repo),
 * written once to the cache directory and played with expo-audio. Failures are silent: haptics still fire.
 */
export class Beep {
  static readonly RATE = 8000;

  /** 16-bit mono PCM WAV of a sine tone with a short fade to avoid clicks. */
  static wav(freqHz = 1760, ms = 70, rate = Beep.RATE): Uint8Array {
    const n = Math.round((rate * ms) / 1000);
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    v.setUint32(4, 36 + n * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, 'data');
    v.setUint32(40, n * 2, true);
    const fade = Math.max(1, Math.round(n * 0.15));
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / fade, (n - 1 - i) / fade);
      v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * freqHz * i) / rate) * 0.6 * env * 32767), true);
    }
    return new Uint8Array(buf);
  }

  private static player: { seekTo(s: number): Promise<void>; play(): void } | null = null;
  private static loading: Promise<void> | null = null;

  static async play(): Promise<void> {
    try {
      Beep.loading ??= (async () => {
        const [{ File, Paths }, { createAudioPlayer, setAudioModeAsync }] = await Promise.all([import('expo-file-system'), import('expo-audio')]);
        const file = new File(Paths.cache, 'stockroom-beep.wav');
        if (!file.exists) await file.write(Beep.wav());
        // Mix with other audio and respect the silent switch (a beep should never be intrusive).
        await setAudioModeAsync({ playsInSilentMode: false, interruptionMode: 'mixWithOthers' });
        Beep.player = createAudioPlayer(file.uri);
      })();
      await Beep.loading;
      if (!Beep.player) return;
      await Beep.player.seekTo(0);
      Beep.player.play();
    } catch {
      Beep.loading = null;
    }
  }
}
