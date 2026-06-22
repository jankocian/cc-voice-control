// Re-export the wire protocol from the single source of truth (src/shared). The
// browser client and the daemon share these types; do not fork them here.
export type {
  BridgeClientRole,
  BridgeEnvelope,
  BrowserToDaemonEvent,
  DaemonToBrowserEvent,
  HistoryTurn,
  InjectMode,
  RegistryEvent,
  RosterEvent,
  RosterThread,
  SessionRuntimeState,
  SessionState,
  SpeakMode,
  ThreadId,
  ThreadInfo,
  ThreadJoined,
  ThreadLabel,
  ThreadLeft,
  ThreadRegister,
  ThreadRoster
} from "../../../src/shared/protocol";
