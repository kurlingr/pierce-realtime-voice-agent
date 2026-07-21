const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const statusEl = document.querySelector("#status");
const eventsEl = document.querySelector("#events");
const remoteAudio = document.querySelector("#remoteAudio");
const waveCanvas = document.querySelector("#waveCanvas");
const waveContext = waveCanvas.getContext("2d");
const modeDescriptionEl = document.querySelector("#modeDescription");
const bookModeButton = document.querySelector("#bookModeButton");
const checkInModeButton = document.querySelector("#checkInModeButton");

const SESSION_LENGTH_MINUTES = 15;
const modes = {
  book: {
    description: "Book a 15-minute session with Pierce.",
    startLabel: "Start",
    readyMessage: "Pierce is ready to capture a 15-minute booking request.",
    instructions:
      "You are Pierce, a friendly voice calendar agent. Speak to guests in plain language only. Do not say technical words like Codex, plugin, API, backend, request ID, tool, or function. Start with: \"Hi, welcome. I can help book your 15-minute session.\" Then immediately get recording consent: \"Quick heads up - this voice session may be recorded and transcribed. Is that okay?\" If they do not consent, politely stop. If they consent, lead one question at a time: ask for their name, then email, then what the session is about, then the date and time, then confirm the time in Pacific. Ask for phone only if the guest wants a phone call. For email, convert spoken words like \"at\" and \"dot\" into a normal address, then spell it back as the address you will use. Important known spelling hints: Kurling Robinson starts with K, not C; fokcus.com is spelled f-o-k-c-u-s, not focus.com. If the guest spells letters, prefer those letters over the likely word. Before saving the request, say: \"Okay - I've got {name}, {email}, {date} at {time} Pacific, 15 minutes, about {topic}. Should I check the calendar and send the invite?\" Only after an explicit yes, call prepare_booking_request. Never say the event is definitely booked and never give a confirmation code. After the request is saved, say: \"Thank you. You'll get a calendar invitation once your session is booked. Have a great session.\" If the saved result says spelling was cleaned up, naturally mention the corrected name or email in the readback next time. If the tool says invalid_email, ask the guest to repeat the email and spell it back again."
  },
  "check-in": {
    description: "Check in for your session with your name.",
    startLabel: "Start check-in",
    readyMessage: "Pierce is ready to check in a guest by name.",
    instructions:
      "You are Pierce, a friendly voice check-in agent. Speak to guests in plain language only. Do not say technical words like Codex, plugin, API, backend, request ID, tool, or function. Start with: \"Hi, welcome. I can check you in for your session.\" Then immediately get recording consent: \"Quick heads up - this voice session may be recorded and transcribed. Is that okay?\" If they do not consent, politely stop. If they consent, ask only for the name they used to book. Read it back: \"I heard {name}. Is that right?\" Important known spelling hint: Kurling Robinson starts with K, not C. If the guest spells or corrects the name, use the corrected spelling. Do not ask for email. If the guest naturally says the session time, include it, but do not ask for it unless you need to tell apart more than one possible session. Only after an explicit yes, call prepare_check_in_request. After the request is saved, say: \"Thank you. You're checked in. Have a great session.\""
  }
};

let peerConnection;
let dataChannel;
let localStream;
let waveAudioContext;
let waveAnalyser;
let waveFrameId;
let waveSource;
let activeMode = "book";
const handledCallIds = new Set();

function setStatus(message) {
  statusEl.textContent = message;
}

function log(message) {
  const item = document.createElement("li");
  item.textContent = message;
  eventsEl.prepend(item);
}

function setMode(mode) {
  if (peerConnection) return;

  activeMode = mode;
  modeDescriptionEl.textContent = modes[mode].description;
  startButton.textContent = modes[mode].startLabel;
  bookModeButton.classList.toggle("active", mode === "book");
  checkInModeButton.classList.toggle("active", mode === "check-in");
  bookModeButton.setAttribute("aria-checked", String(mode === "book"));
  checkInModeButton.setAttribute("aria-checked", String(mode === "check-in"));
}

function setModeDisabled(disabled) {
  bookModeButton.disabled = disabled;
  checkInModeButton.disabled = disabled;
}

function sizeWaveCanvas() {
  const pixelRatio = window.devicePixelRatio || 1;
  const rect = waveCanvas.getBoundingClientRect();
  waveCanvas.width = Math.max(1, Math.floor(rect.width * pixelRatio));
  waveCanvas.height = Math.max(1, Math.floor(rect.height * pixelRatio));
  waveContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  return rect;
}

function drawFlatWave() {
  const { width, height } = sizeWaveCanvas();
  waveContext.clearRect(0, 0, width, height);
  waveContext.strokeStyle = "#8b949e";
  waveContext.lineWidth = 2;
  waveContext.beginPath();
  waveContext.moveTo(16, height / 2);
  waveContext.lineTo(width - 16, height / 2);
  waveContext.stroke();
}

function drawLiveWave() {
  if (!waveAnalyser) {
    drawFlatWave();
    return;
  }

  const { width, height } = sizeWaveCanvas();
  const samples = new Uint8Array(waveAnalyser.fftSize);
  waveAnalyser.getByteTimeDomainData(samples);

  waveContext.clearRect(0, 0, width, height);
  waveContext.strokeStyle = "#176b3a";
  waveContext.lineWidth = 2.5;
  waveContext.beginPath();

  const slice = width / (samples.length - 1);
  for (let index = 0; index < samples.length; index += 1) {
    const centered = (samples[index] - 128) / 128;
    const x = index * slice;
    const y = height / 2 + centered * (height * 0.42);
    if (index === 0) waveContext.moveTo(x, y);
    else waveContext.lineTo(x, y);
  }

  waveContext.stroke();
  waveFrameId = requestAnimationFrame(drawLiveWave);
}

async function startWaveform(stream) {
  stopWaveform();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    drawFlatWave();
    return;
  }

  waveAudioContext = new AudioContextClass();
  waveSource = waveAudioContext.createMediaStreamSource(stream);
  waveAnalyser = waveAudioContext.createAnalyser();
  waveAnalyser.fftSize = 1024;
  waveSource.connect(waveAnalyser);
  await waveAudioContext.resume();
  drawLiveWave();
}

function stopWaveform() {
  if (waveFrameId !== undefined) cancelAnimationFrame(waveFrameId);
  const audioContext = waveAudioContext;

  waveFrameId = undefined;
  waveSource = undefined;
  waveAnalyser = undefined;
  waveAudioContext = undefined;

  if (audioContext && audioContext.state !== "closed") {
    audioContext.close().catch(() => {});
  }

  drawFlatWave();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  return { status: response.status, ...result };
}

function formatRequestMessage(result) {
  if (result.ok) {
    const corrected = result.capture_corrections?.name || result.capture_corrections?.email;
    return `Thank you. You'll get a calendar invitation once your session is booked. Have a great session.${corrected ? " I cleaned up the spelling." : ""}`;
  }
  if (result.reason === "missing_required_fields") {
    return "Booking request was not saved because required guest details or recording consent were missing.";
  }
  if (result.reason === "past_time") {
    return "That time is in the past. Ask for a future slot.";
  }
  if (result.reason === "invalid_email") {
    return `The captured email did not look valid: ${result.captured_email}. Ask the guest to repeat it, then spell it back as a normal email address.`;
  }
  return "Booking request was not saved. Tell the guest it did not go through.";
}

function formatCheckInMessage(result) {
  if (result.ok) {
    const corrected = result.capture_corrections?.name;
    return `You're checked in. Have a great session.${corrected ? " I cleaned up the spelling." : ""}`;
  }
  if (result.reason === "missing_required_fields") {
    return "Check-in was not saved because the confirmed name or recording consent was missing.";
  }
  return "Check-in was not saved. Tell the guest it did not go through.";
}

function sendEvent(event) {
  if (dataChannel?.readyState === "open") {
    dataChannel.send(JSON.stringify(event));
  }
}

function calendarToolSchema() {
  return [
    {
      type: "function",
      name: "prepare_booking_request",
      description:
        "Saves a complete 15-minute booking request. This does not create a calendar event.",
      parameters: {
        type: "object",
        properties: {
          guest_name: {
            type: "string",
            description: "Guest's full name."
          },
          guest_email: {
            type: "string",
            description: "Guest email address as a normal address, such as jane@example.com, already spelled back and confirmed."
          },
          topic: {
            type: "string",
            description: "One short line describing what the 15-minute session is about."
          },
          timezone_confirm: {
            type: "string",
            description: "Confirmed timezone wording, such as Pacific."
          },
          phone: {
            type: "string",
            description: "Optional phone number only if the guest wants a phone call."
          },
          recording_consent: {
            type: "boolean",
            description: "True only if the guest agreed the voice session may be recorded and transcribed."
          },
          date: {
            type: "string",
            description: "Confirmed Pacific date in YYYY-MM-DD format."
          },
          time: {
            type: "string",
            description: "Confirmed Pacific start time, preferably HH:MM:SS in 24-hour time."
          }
        },
        required: [
          "guest_name",
          "guest_email",
          "topic",
          "timezone_confirm",
          "recording_consent",
          "date",
          "time"
        ],
        additionalProperties: false
      }
    }
  ];
}

function checkInToolSchema() {
  return [
    {
      type: "function",
      name: "prepare_check_in_request",
      description:
        "Saves a guest check-in request by confirmed booking name. This does not create or edit a calendar event.",
      parameters: {
        type: "object",
        properties: {
          guest_name: {
            type: "string",
            description: "Guest's confirmed booking name."
          },
          recording_consent: {
            type: "boolean",
            description: "True only if the guest agreed the voice session may be recorded and transcribed."
          },
          date: {
            type: "string",
            description: "Optional session date in YYYY-MM-DD format. Use today's date if the guest means today."
          },
          session_time: {
            type: "string",
            description: "Optional session time if the guest provides it."
          }
        },
        required: ["guest_name", "recording_consent"],
        additionalProperties: false
      }
    }
  ];
}

function registerCalendarTools() {
  const mode = modes[activeMode];

  sendEvent({
    type: "session.update",
    session: {
      type: "realtime",
      instructions: mode.instructions,
      tools: activeMode === "check-in" ? checkInToolSchema() : calendarToolSchema(),
      tool_choice: "auto"
    }
  });

  log(mode.readyMessage);
}

function sendToolResult(callId, output) {
  sendEvent({
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(output)
    }
  });

  sendEvent({ type: "response.create" });
}

async function handleFunctionCall(item) {
  if (handledCallIds.has(item.call_id)) return;
  handledCallIds.add(item.call_id);

  let args = {};
  try {
    args = JSON.parse(item.arguments || "{}");
  } catch {
    args = {};
  }

  if (item.name === "prepare_booking_request") {
    const result = await postJson("/booking/request", args);
    result.message = result.message || formatRequestMessage(result);
    log(result.message);
    sendToolResult(item.call_id, result);
  }

  if (item.name === "prepare_check_in_request") {
    const result = await postJson("/check-in/request", args);
    result.message = result.message || formatCheckInMessage(result);
    log(result.message);
    sendToolResult(item.call_id, result);
  }
}

function handleServerEvent(event) {
  if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
    handleFunctionCall(event.item);
  }

  if (event.type === "response.function_call_arguments.done") {
    handleFunctionCall(event);
  }

  if (event.type === "response.done") {
    const output = event.response?.output || [];
    output.filter((item) => item.type === "function_call").forEach(handleFunctionCall);
  }

  if (event.type === "error") {
    log(event.error?.message || "Realtime error");
  }
}

async function start() {
  startButton.disabled = true;
  setModeDisabled(true);
  setStatus("Connecting to Pierce...");
  eventsEl.replaceChildren();

  try {
    handledCallIds.clear();
    peerConnection = new RTCPeerConnection();

    peerConnection.ontrack = (event) => {
      remoteAudio.srcObject = event.streams[0];
    };

    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
    await startWaveform(localStream);

    dataChannel = peerConnection.createDataChannel("oai-events");
    dataChannel.addEventListener("open", () => {
      setStatus("Connected to Pierce");
      stopButton.disabled = false;
      registerCalendarTools();
      sendEvent({ type: "response.create" });
    });
    dataChannel.addEventListener("message", (message) => {
      handleServerEvent(JSON.parse(message.data));
    });

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    const response = await fetch(`/session?mode=${encodeURIComponent(activeMode)}`, {
      method: "POST",
      headers: {
        "content-type": "application/sdp"
      },
      body: offer.sdp
    });

    const answerSdp = await response.text();
    if (!response.ok) {
      throw new Error(answerSdp || "Unable to create realtime session.");
    }

    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: answerSdp
    });
  } catch (error) {
    stop();
    log(error.message);
    setStatus("Disconnected");
    startButton.disabled = false;
    setModeDisabled(false);
  }
}

function stop() {
  dataChannel?.close();
  peerConnection?.close();
  localStream?.getTracks().forEach((track) => track.stop());
  stopWaveform();

  dataChannel = undefined;
  peerConnection = undefined;
  localStream = undefined;
  remoteAudio.srcObject = null;
  startButton.disabled = false;
  stopButton.disabled = true;
  setModeDisabled(false);
  setStatus("Stopped");
}

startButton.addEventListener("click", start);
stopButton.addEventListener("click", stop);
bookModeButton.addEventListener("click", () => setMode("book"));
checkInModeButton.addEventListener("click", () => setMode("check-in"));
window.addEventListener("resize", () => {
  if (!waveAnalyser) drawFlatWave();
});
setMode(activeMode);
drawFlatWave();
