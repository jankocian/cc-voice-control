export function Header({ rateLabel, onCycleSpeed }: { rateLabel: string; onCycleSpeed: () => void }) {
  return (
    <header class="app-header">
      <h1 class="app-title">voice control</h1>
      <button id="speedButton" class="speed-pill" type="button" aria-label="Playback speed" onClick={onCycleSpeed}>
        {rateLabel}
      </button>
    </header>
  );
}
