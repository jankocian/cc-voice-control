// SVG icons ported verbatim from the vanilla client (PLAY_SVG / REPLAY_SVG / mic).

export function MicIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect x="9" y="2.5" width="6" height="11.5" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="21.5" />
    </svg>
  );
}

// Both play + pause glyphs render; CSS shows the right one based on the
// .playing class on the parent .entry (faithful to PLAY_SVG).
export function PlayPauseIcons() {
  return (
    <>
      <svg class="ic-play" viewBox="0 0 24 24" fill="currentColor">
        <path d="M8 5.5v13l10-6.5z" />
      </svg>
      <svg class="ic-pause" viewBox="0 0 24 24" fill="currentColor">
        <path d="M7.5 5h3v14h-3zM13.5 5h3v14h-3z" />
      </svg>
    </>
  );
}

export function ReplayIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M3 11a9 9 0 1 1 2.6 6.4" />
      <path d="M3 5v6h6" />
    </svg>
  );
}
