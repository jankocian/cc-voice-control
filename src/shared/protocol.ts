export type SessionRuntimeState =
  | "idle"
  | "working"
  | "voice_connected"
  | "voice_suspended"
  | "paused_for_user"
  | "stopping";

export type SessionState = {
  sessionId: string;
  daemonConnected: boolean;
  browserConnected: boolean;
  // True while Claude Code is actively polling for messages (the voice loop is live).
  // Goes false if the loop stops (e.g. the user cancels Claude) even though the
  // daemon process — and thus the bridge connection — is still up.
  listening: boolean;
  state: SessionRuntimeState;
  createdAt: number;
  expiresAt: number;
};

export type TaskRecord = {
  id: string;
  text: string;
  startedAt: number;
  finishedAt?: number;
  summary?: string;
  status: "pending" | "active" | "completed" | "cancelled" | "failed";
};

export type SessionMemory = {
  currentTask?: string;
  lastSummary?: string;
  lastResponse?: string;
  steeringNotes: string[];
  taskHistory: TaskRecord[];
};

export type VoiceMessageKind =
  | "instruction"
  | "status_request"
  | "summary_request"
  | "interrupt"
  | "stop_session";

export type VoiceMessage = {
  id: string;
  kind: VoiceMessageKind;
  text: string;
  createdAt: number;
  priority: "normal" | "high";
};

export type BrowserToDaemonEvent =
  | {
      type: "request_voice_signed_url";
      requestId: string;
    }
  | {
      type: "submit_audio";
      requestId: string;
      audioBase64: string;
      mimeType: string;
    }
  | {
      type: "voice_instruction";
      requestId: string;
      text: string;
    }
  | {
      type: "status_request";
      requestId: string;
    }
  | {
      type: "summary_request";
      requestId: string;
    }
  | {
      type: "steering_note";
      requestId: string;
      text: string;
    }
  | {
      type: "interrupt";
      requestId: string;
      text: string;
    }
  | {
      type: "stop_task";
      requestId: string;
    };

export type DaemonToBrowserEvent =
  | {
      type: "session_status";
      state: SessionState;
      memory: Pick<SessionMemory, "currentTask" | "lastSummary" | "lastResponse" | "steeringNotes">;
    }
  | {
      type: "voice_signed_url";
      requestId: string;
      signedUrl: string;
    }
  | {
      type: "transcript";
      requestId: string;
      text: string;
    }
  | {
      type: "claude_reply";
      requestId: string;
      text: string;
      backgroundMode?: boolean;
    }
  | {
      type: "tts_audio";
      requestId: string;
      audioBase64: string;
      mimeType: string;
    }
  | {
      type: "ack";
      requestId: string;
      message: string;
    }
  | {
      type: "bridge_presence";
      daemonConnected: boolean;
      browserConnected: boolean;
    }
  | {
      type: "error";
      requestId?: string;
      message: string;
    };

export type BridgeClientRole = "daemon" | "browser";

export type BridgeEnvelope =
  | {
      channel: "daemon";
      event: BrowserToDaemonEvent;
    }
  | {
      channel: "browser";
      event: DaemonToBrowserEvent;
    };

export function isInterruptText(text: string): boolean {
  return /\b(stop|cancel|wait|pause|hold on|don't|do not|abort)\b/i.test(text);
}
