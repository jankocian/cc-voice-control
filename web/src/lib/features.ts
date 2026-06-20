// Feature flags for UI surfaces intentionally hidden in the current single-screen
// experience but kept in the codebase so they can be switched back on (no rebuild
// of the components needed) as the product grows.
export const FEATURES = {
  /** Bottom tab bar: Threads · voice · New thread. */
  threadNav: false,
  /** Top-left menu (threads drawer) button. */
  threadMenu: false,
  /** Centered thread title + dropdown switcher (the cmux task title · repo · branch; the dropdown
   *  appears once a 2nd thread joins). Single thread → just the label pill. */
  threadTitle: true,
  /** Top-right settings / adjustments button. */
  settings: false,
  /** The waveform button beside the mic (no defined behaviour yet). */
  micSideButton: false
} as const;
