export type BrowserClientScriptInput = {
  sessionId: string;
  token: string;
};

/**
 * Push-to-talk browser client.
 *
 * - Tap to record (audio-reactive visualizer), tap to send → daemon transcribes
 *   (ElevenLabs STT) and the transcript appears as "You: …".
 * - The daemon never fabricates replies; only Claude's reply is shown and spoken.
 * - Replies auto-play; every reply has play/pause (tap it) and a replay button, and
 *   a header pill controls (and remembers) playback speed.
 * - The status panel is the primary feedback surface (color-filled per state, with a
 *   subtle sweep while Claude is working). No third-party SDK runs in the browser.
 */
export function renderBrowserClientModuleScript({ sessionId, token }: BrowserClientScriptInput): string {
  return String.raw`
    const sessionId = ${toInlineJson(sessionId)};
    const token = ${toInlineJson(token)};
    const expiresAt = new URL(location.href).searchParams.get("expiresAt") || "";
    const wsUrl = new URL("/ws/" + encodeURIComponent(sessionId), location.href);
    wsUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.searchParams.set("token", token);
    wsUrl.searchParams.set("role", "browser");
    if (expiresAt) wsUrl.searchParams.set("expiresAt", expiresAt);

    const SPEEDS = [1, 1.25, 1.5, 1.75, 2];
    const RATE_KEY = "voiceRemote.playbackRate";
    const MAX_LOG = 60;
    const PLAY_SVG = '<svg class="ic-play" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l10-6.5z"/></svg><svg class="ic-pause" viewBox="0 0 24 24" fill="currentColor"><path d="M7.5 5h3v14h-3zM13.5 5h3v14h-3z"/></svg>';
    const REPLAY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11a9 9 0 1 1 2.6 6.4"/><path d="M3 5v6h6"/></svg>';

    let socket;
    let mediaRecorder;
    let mediaStream;
    let chunks = [];
    let recording = false;
    let transcribing = false;
    let transientUntil = 0;
    let transientText = "";
    let transientTimer = 0;

    let audioCtx;
    let analyser;
    let freqData;
    let rafId = 0;

    let playbackRate = clampRate(parseFloat(localStorage.getItem(RATE_KEY)));
    let currentPlayingId = null;
    let currentUrl = null;
    const audioByRequest = new Map();
    const entryByRequest = new Map();

    const bridge = { daemonConnected: false, browserConnected: false };
    const runtime = { state: "idle", currentTask: undefined, listening: true };
    const player = new Audio();

    const el = {
      statusPanel: document.getElementById("statusPanel"),
      lamp: document.getElementById("lamp"),
      state: document.getElementById("stateLabel"),
      detail: document.getElementById("detailLabel"),
      log: document.getElementById("log"),
      voiceButton: document.getElementById("voiceButton"),
      voiceLabel: document.getElementById("voiceLabel"),
      summaryButton: document.getElementById("summaryButton"),
      statusButton: document.getElementById("statusButton"),
      stopButton: document.getElementById("stopButton"),
      speedButton: document.getElementById("speedButton"),
      visualizer: document.getElementById("visualizer"),
      canvas: document.getElementById("waveform")
    };
    const waveCtx = el.canvas.getContext("2d");

    player.playbackRate = playbackRate;
    player.addEventListener("play", () => setPlayingClass(currentPlayingId, true));
    player.addEventListener("pause", () => setPlayingClass(currentPlayingId, false));
    player.addEventListener("ended", () => { setPlayingClass(currentPlayingId, false); currentPlayingId = null; });
    player.addEventListener("error", () => { setPlayingClass(currentPlayingId, false); currentPlayingId = null; });
    window.addEventListener("pagehide", teardown);

    el.speedButton.textContent = formatRate(playbackRate);
    render();
    connectBridge();

    el.voiceButton.addEventListener("click", toggleRecording);
    el.summaryButton.addEventListener("click", () => sendControl({ type: "summary_request" }));
    el.statusButton.addEventListener("click", () => sendControl({ type: "status_request" }));
    el.stopButton.addEventListener("click", () => sendControl({ type: "stop_task" }));
    el.speedButton.addEventListener("click", cycleSpeed);
    el.log.addEventListener("click", (event) => {
      const entry = event.target.closest(".entry.playable");
      if (!entry || !entry.dataset.requestId) return;
      if (event.target.closest(".replay-btn")) replayEntry(entry.dataset.requestId);
      else playEntry(entry.dataset.requestId);
    });

    function connectBridge() {
      socket = new WebSocket(wsUrl);
      socket.addEventListener("message", (event) => {
        let envelope;
        try { envelope = JSON.parse(event.data); } catch { return; }
        if (!envelope || envelope.channel !== "browser") return;
        handleBrowserEvent(envelope.event);
      });
      socket.addEventListener("open", render);
      socket.addEventListener("close", () => {
        bridge.daemonConnected = false;
        bridge.browserConnected = false;
        render();
        setTimeout(connectBridge, 1500);
      });
      socket.addEventListener("error", render);
    }

    // ---- recording ------------------------------------------------------------

    function toggleRecording() {
      if (transcribing) return;
      if (recording) { stopRecording(); return; }
      startRecording();
    }

    async function startRecording() {
      if (!bridgeReady()) { flash("Not connected to Claude Code yet"); return; }
      if (!navigator.mediaDevices || !window.MediaRecorder) { flash("This browser cannot record audio"); return; }
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        flash("Microphone blocked — allow it and try again");
        return;
      }
      stopPlayback();
      chunks = [];
      const mime = pickMimeType();
      mediaRecorder = mime ? new MediaRecorder(mediaStream, { mimeType: mime }) : new MediaRecorder(mediaStream);
      mediaRecorder.addEventListener("dataavailable", (event) => { if (event.data && event.data.size > 0) chunks.push(event.data); });
      mediaRecorder.addEventListener("stop", submitRecording);
      mediaRecorder.start();
      recording = true;
      startVisualizer();
      render();
    }

    function stopRecording() {
      recording = false;
      stopVisualizer();
      try { if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop(); } catch {}
      render();
    }

    async function submitRecording() {
      const mimeType = (mediaRecorder && mediaRecorder.mimeType) || "audio/webm";
      const blob = new Blob(chunks, { type: mimeType });
      chunks = [];
      stopStream();
      if (!blob.size) { flash("Didn't catch that — tap to retry"); render(); return; }
      let audioBase64;
      try { audioBase64 = await blobToBase64(blob); } catch { flash("Could not read the recording"); render(); return; }
      if (!sendDaemon({ type: "submit_audio", audioBase64, mimeType })) { flash("Lost the connection before sending"); render(); return; }
      transcribing = true;
      render();
    }

    function stopStream() {
      if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = undefined; }
    }

    // ---- visualizer (mic-reactive bars) ---------------------------------------

    function startVisualizer() {
      el.visualizer.classList.add("active");
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaStreamSource(mediaStream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.82;
        source.connect(analyser);
        freqData = new Uint8Array(analyser.frequencyBinCount);
        sizeCanvas();
        drawWave();
      } catch {
        // visualizer is decorative; recording still works without it
      }
    }

    function stopVisualizer() {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = undefined; }
      analyser = undefined;
      freqData = undefined;
      el.visualizer.classList.remove("active");
      if (waveCtx) waveCtx.clearRect(0, 0, el.canvas.width, el.canvas.height);
    }

    function sizeCanvas() {
      const dpr = window.devicePixelRatio || 1;
      el.canvas.width = Math.max(1, Math.floor(el.canvas.clientWidth * dpr));
      el.canvas.height = Math.max(1, Math.floor(el.canvas.clientHeight * dpr));
    }

    function drawWave() {
      if (!recording || !analyser) return;
      rafId = requestAnimationFrame(drawWave);
      const w = el.canvas.width;
      const h = el.canvas.height;
      waveCtx.clearRect(0, 0, w, h);
      analyser.getByteFrequencyData(freqData);
      const bars = 40;
      const gap = Math.max(2, w / bars / 3);
      const barW = (w - gap * (bars - 1)) / bars;
      const mid = h / 2;
      const grad = waveCtx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, "#4493f8");
      grad.addColorStop(1, "#a371f7");
      waveCtx.fillStyle = grad;
      const step = Math.max(1, Math.floor(freqData.length / bars));
      for (let i = 0; i < bars; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) sum += freqData[i * step + j] || 0;
        const level = sum / step / 255;
        const barH = Math.max(barW, level * h * 0.92);
        const x = i * (barW + gap);
        waveCtx.beginPath();
        waveCtx.roundRect(x, mid - barH / 2, barW, barH, barW / 2);
        waveCtx.fill();
      }
    }

    // ---- bridge events --------------------------------------------------------

    function sendControl(event) {
      if (!sendDaemon(event)) flash(bridgeReady() ? "Couldn't reach Claude Code" : "Not connected yet");
    }

    function handleBrowserEvent(event) {
      if (!event) return;
      switch (event.type) {
        case "bridge_presence":
          bridge.daemonConnected = event.daemonConnected === true;
          bridge.browserConnected = event.browserConnected === true;
          render();
          return;
        case "session_status":
          bridge.daemonConnected = event.state.daemonConnected === true;
          bridge.browserConnected = event.state.browserConnected === true;
          runtime.listening = event.state.listening === true;
          runtime.state = event.state.state;
          runtime.currentTask = event.memory && event.memory.currentTask;
          render();
          return;
        case "transcript":
          transcribing = false;
          addLog("You", event.text);
          flash("Sent to Claude Code ✓");
          render();
          return;
        case "ack":
          return; // delivery receipt only — the ✓ on your message is the confirmation
        case "claude_reply":
          addLog("Claude Code", event.text, event.requestId);
          render();
          return;
        case "tts_audio":
          attachAudio(event.requestId, event.audioBase64, event.mimeType);
          return;
        case "error":
          transcribing = false;
          flash(event.message);
          render();
          return;
      }
    }

    // ---- playback (per message) -----------------------------------------------

    function attachAudio(requestId, audioBase64, mimeType) {
      if (!requestId || !audioBase64) return;
      audioByRequest.set(requestId, { audioBase64, mimeType });
      const entry = entryByRequest.get(requestId);
      if (entry && !entry.classList.contains("playable")) {
        entry.classList.add("playable");
        const controls = document.createElement("span");
        controls.className = "entry-controls";
        const replay = document.createElement("button");
        replay.type = "button";
        replay.className = "ec-btn replay-btn";
        replay.setAttribute("aria-label", "Replay this message");
        replay.innerHTML = REPLAY_SVG;
        const icon = document.createElement("span");
        icon.className = "entry-icon";
        icon.innerHTML = PLAY_SVG;
        controls.append(replay, icon);
        entry.insertBefore(controls, entry.firstChild);
      }
      if (!recording) playEntry(requestId); // auto-play the reply
    }

    function loadEntry(requestId) {
      const audio = audioByRequest.get(requestId);
      if (!audio) return false;
      if (currentPlayingId !== requestId) {
        player.pause();
        currentPlayingId = requestId;
        if (currentUrl) URL.revokeObjectURL(currentUrl);
        currentUrl = URL.createObjectURL(blobFromBase64(audio.audioBase64, audio.mimeType));
        player.src = currentUrl;
        player.playbackRate = playbackRate;
      }
      return true;
    }

    function playEntry(requestId) {
      if (currentPlayingId === requestId) {
        if (player.paused) {
          if (player.ended) player.currentTime = 0;
          player.play().catch(() => {});
        } else {
          player.pause();
        }
        return;
      }
      if (loadEntry(requestId)) player.play().catch(() => {});
    }

    function replayEntry(requestId) {
      if (!loadEntry(requestId)) return;
      player.currentTime = 0;
      player.playbackRate = playbackRate;
      player.play().catch(() => {});
    }

    function stopPlayback() {
      try { player.pause(); } catch {}
    }

    function setPlayingClass(requestId, on) {
      for (const [id, entry] of entryByRequest) entry.classList.toggle("playing", on && id === requestId);
      render();
    }

    function cycleSpeed() {
      playbackRate = SPEEDS[(SPEEDS.indexOf(playbackRate) + 1) % SPEEDS.length];
      player.playbackRate = playbackRate;
      try { localStorage.setItem(RATE_KEY, String(playbackRate)); } catch {}
      el.speedButton.textContent = formatRate(playbackRate);
    }

    function clampRate(rate) { return SPEEDS.indexOf(rate) >= 0 ? rate : 1; }
    function formatRate(rate) { return rate + "×"; }

    // ---- bridge i/o -----------------------------------------------------------

    function sendDaemon(event) {
      if (!bridgeReady()) return false;
      const requestId = crypto.randomUUID();
      try {
        socket.send(JSON.stringify({ channel: "daemon", event: { requestId, ...event } }));
        return true;
      } catch {
        return false;
      }
    }

    function bridgeReady() {
      return socket && socket.readyState === WebSocket.OPEN && bridge.daemonConnected === true;
    }

    // ---- ui -------------------------------------------------------------------

    function flash(text) {
      transientText = text;
      transientUntil = Date.now() + 2600;
      if (transientTimer) clearTimeout(transientTimer);
      transientTimer = setTimeout(render, 2700);
      render();
    }

    function speaking() { return currentPlayingId !== null && !player.paused; }

    function render() {
      const connected = socket && socket.readyState === WebSocket.OPEN;
      const ready = connected && bridge.daemonConnected === true;
      let stateKey = "offline";
      let title;
      let detail;

      if (!connected) {
        title = "Connecting…";
        detail = "Reaching the bridge";
      } else if (!ready) {
        title = "Waiting for Claude Code";
        detail = "The daemon is offline";
      } else if (recording) {
        stateKey = "recording";
        title = "Listening…";
        detail = "Tap again to send";
      } else if (transcribing) {
        stateKey = "sending";
        title = "Sending…";
        detail = "Transcribing your voice";
      } else if (speaking()) {
        stateKey = "speaking";
        title = "Speaking";
        detail = "Tap a message to pause or replay";
      } else if (runtime.state === "working") {
        stateKey = "working";
        title = "Claude is working";
        detail = runtime.currentTask || "Working on your request…";
      } else if (runtime.state === "paused_for_user") {
        stateKey = "working";
        title = "Paused for you";
        detail = runtime.currentTask || "Awaiting your input";
      } else if (!runtime.listening) {
        stateKey = "offline";
        title = "Claude isn't listening";
        detail = "Restart with /voice-command:start in the terminal";
      } else {
        stateKey = "ready";
        title = "Ready";
        detail = "Tap the mic and speak";
      }

      if (Date.now() < transientUntil && transientText) detail = transientText;

      el.statusPanel.dataset.state = stateKey;
      el.lamp.className = "lamp" + (stateKey === "ready" ? " connected" : stateKey === "recording" ? " recording" : stateKey === "speaking" ? " speaking" : stateKey === "working" || stateKey === "sending" ? " working" : "");
      el.state.textContent = title;
      el.detail.textContent = detail;

      el.voiceLabel.textContent = recording ? "Tap to Send" : transcribing ? "Sending…" : "Tap to Speak";
      el.voiceButton.classList.toggle("recording", recording);
      el.voiceButton.disabled = !ready || transcribing;
      el.summaryButton.disabled = !ready;
      el.statusButton.disabled = !ready;
      el.stopButton.disabled = !ready;
    }

    function addLog(title, body, requestId) {
      const kinds = { "You": "you", "Claude Code": "claude" };
      const row = document.createElement("article");
      row.className = "entry";
      row.dataset.kind = kinds[title] || "system";
      if (requestId) row.dataset.requestId = requestId;
      const time = document.createElement("time");
      time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " · " + title;
      const p = document.createElement("p");
      p.textContent = body;
      row.append(time, p);
      el.log.prepend(row);
      if (title === "Claude Code" && requestId) entryByRequest.set(requestId, row);
      pruneLog();
    }

    // Bound memory: drop the oldest entries and their cached audio.
    function pruneLog() {
      while (el.log.children.length > MAX_LOG) {
        const old = el.log.lastElementChild;
        if (!old) break;
        const id = old.dataset.requestId;
        if (id) {
          if (id === currentPlayingId) { stopPlayback(); currentPlayingId = null; }
          audioByRequest.delete(id);
          entryByRequest.delete(id);
        }
        old.remove();
      }
    }

    function teardown() {
      try { stopVisualizer(); } catch {}
      try { stopStream(); } catch {}
      try { player.pause(); } catch {}
      if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
      if (transientTimer) clearTimeout(transientTimer);
    }

    function pickMimeType() {
      const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
      for (const candidate of candidates) {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(candidate)) return candidate;
      }
      return "";
    }

    function blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = String(reader.result || "");
          const comma = result.indexOf(",");
          resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => reject(reader.error || new Error("read failed"));
        reader.readAsDataURL(blob);
      });
    }

    function blobFromBase64(base64, mimeType) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: mimeType || "audio/mpeg" });
    }
  `.trim();
}

function toInlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}
