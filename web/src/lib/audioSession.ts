// WebKit-only `navigator.audioSession` control (iOS/macOS Safari 16.4+). This is the
// single lever that makes background music (Spotify, podcasts, …) behave the way we
// want on iOS:
//   • "transient-solo"  → pause other audio, then AUTO-RESUME it when ours ends. We use
//                         this around a TTS reply so music ducks out, the reply plays,
//                         and the music comes back. It is the ONLY type whose spec
//                         semantics guarantee resume.
//   • "play-and-record" → the recording category. Required before getUserMedia: the
//                         Audio Session spec says a mic track is ENDED on interruption
//                         (screen lock) unless the session is play-and-record/auto, so
//                         setting this is what keeps recording alive across a lock.
//   • "auto"            → hand control back to the UA so paused apps can resume. We reset
//                         to this after a reply finishes / after recording stops.
//
// Everywhere the API is missing (Android, desktop Chrome/Firefox, iOS < 16.4) every call
// is a silent no-op and behaviour degrades to "music stays paused" — exactly today's.
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
