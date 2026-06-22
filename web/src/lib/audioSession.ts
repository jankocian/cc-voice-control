// WebKit-only `navigator.audioSession` control (iOS/macOS Safari 16.4+) — how the page shares
// audio with other apps (Spotify, podcasts, …) on iOS. The categories we actually use:
//   • "ambient"         → mixable playback. A TTS reply plays OVER background music instead of
//                         pausing it; we use this for every reply. iOS WebKit CAN pause other audio
//                         ("transient-solo") but does NOT reliably resume it afterwards, so the only
//                         way to keep music alive is to never pause it. Trade-off: ambient obeys the
//                         device mute switch (fine while music is audibly playing).
//   • "play-and-record" → the recording category. Required before getUserMedia: the Audio Session
//                         spec says a mic track is ENDED on interruption (screen lock) unless the
//                         session is play-and-record/auto, so this keeps recording alive across a
//                         lock. While the mic is held it DOES duck other audio (iOS couples mic with
//                         record-mode) — unavoidable.
//   • "auto"            → hand control back to the UA. We reset to this when idle (recording stops /
//                         backgrounding).
// "transient-solo" stays in the union as a valid API value but is intentionally unused — its promised
// auto-resume is exactly the part WebKit never delivers.
//
// Everywhere the API is missing (Android, desktop Chrome/Firefox, iOS < 16.4) every call is a silent
// no-op (music behaviour falls back to whatever the UA does by default).
export type AudioSessionType = "auto" | "playback" | "transient" | "transient-solo" | "ambient" | "play-and-record";

interface AudioSessionLike {
  type: AudioSessionType;
}

function audioSession(): AudioSessionLike | undefined {
  if (typeof navigator === "undefined") return undefined;
  // Not in lib.dom.d.ts yet — feature-detect + cast.
  return (navigator as unknown as { audioSession?: AudioSessionLike }).audioSession;
}

/** Set the page audio-session category. No-op (and never throws) where unsupported. */
export function setAudioSessionType(type: AudioSessionType): void {
  const session = audioSession();
  if (!session) return;
  try {
    if (session.type !== type) session.type = type;
  } catch {
    // best-effort; some types reject while an incompatible track is live
  }
}
