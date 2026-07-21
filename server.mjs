import { createServer } from "node:http";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const ownerTimezone = "America/Los_Angeles";
const sessionMinutes = 15;
const workDir = join(__dirname, "work");
const bookingRequestsPath = join(workDir, "booking-requests.jsonl");
const checkInRequestsPath = join(workDir, "check-in-requests.jsonl");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

function send(req, res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type });
  res.end(req.method === "HEAD" ? undefined : body);
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req) {
  const body = await readRequestBody(req);
  if (!body.trim()) return {};
  return JSON.parse(body);
}

function sendJson(req, res, status, body) {
  send(req, res, status, JSON.stringify(body), "application/json; charset=utf-8");
}

function normalizeTime(time) {
  const value = String(time || "").trim();
  const match12 = value.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (match12) {
    let hour = Number(match12[1]);
    const minute = Number(match12[2] || "0");
    const meridiem = match12[3].toUpperCase();
    if (meridiem === "PM" && hour !== 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  }

  const match24 = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match24) {
    return `${String(Number(match24[1])).padStart(2, "0")}:${match24[2]}:${match24[3] || "00"}`;
  }

  return value;
}

function normalizeSpokenEmail(email) {
  const normalized = String(email || "")
    .trim()
    .toLowerCase()
    .replace(/\s+at\s+/g, "@")
    .replace(/\s+dot\s+/g, ".")
    .replace(/\s+/g, "");

  const knownCorrections = {
    "curling@focus.com": "kurling@fokcus.com",
    "kurling@focus.com": "kurling@fokcus.com",
    "curling@fokcus.com": "kurling@fokcus.com"
  };

  return knownCorrections[normalized] || normalized;
}

function normalizeGuestName(name) {
  const value = String(name || "").trim();
  const knownCorrections = {
    "curling robinson": "Kurling Robinson",
    "curlan robinson": "Kurling Robinson"
  };

  return knownCorrections[value.toLowerCase()] || value;
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function pacificOffset(dateStr) {
  const date = new Date(`${dateStr}T12:00:00Z`);
  const offsetName = new Intl.DateTimeFormat("en-US", {
    timeZone: ownerTimezone,
    timeZoneName: "shortOffset"
  })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;

  const match = offsetName?.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
  if (!match) throw new Error(`Unable to determine Pacific offset for ${dateStr}`);

  const hours = Number(match[1]);
  const minutes = Number(match[2] || "0");
  const sign = hours < 0 ? "-" : "+";
  return `${sign}${String(Math.abs(hours)).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function addMinutesLocal(dateStr, timeStr, minutes) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute, second = 0] = timeStr.split(":").map(Number);
  const date = new Date(year, month - 1, day, hour, minute, second);
  date.setMinutes(date.getMinutes() + minutes);
  const pad = (value) => String(value).padStart(2, "0");

  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  };
}

function localDateTimeToInstant(date, time) {
  return new Date(`${date}T${time}${pacificOffset(date)}`);
}

function isPastSlot(date, time) {
  return localDateTimeToInstant(date, time).getTime() <= Date.now();
}

function todayInPacific() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ownerTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function nowInPacific() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ownerTimezone,
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date());
}

async function handleBookingRequest(req, res) {
  const body = await readJson(req);
  const normalizedEmail = normalizeSpokenEmail(body.guest_email);
  const normalizedName = normalizeGuestName(body.guest_name);
  const guest = {
    name: normalizedName,
    email: normalizedEmail,
    topic: String(body.topic || "").trim(),
    phone: String(body.phone || "").trim()
  };
  const date = String(body.date || "").trim();
  const time = normalizeTime(body.time);

  if (!guest.name || !guest.email || !guest.topic || !date || !time || body.recording_consent !== true) {
    sendJson(req, res, 400, { ok: false, reason: "missing_required_fields" });
    return;
  }

  if (!isEmail(guest.email)) {
    sendJson(req, res, 400, { ok: false, reason: "invalid_email", captured_email: body.guest_email });
    return;
  }

  if (isPastSlot(date, time)) {
    sendJson(req, res, 400, { ok: false, reason: "past_time" });
    return;
  }

  const end = addMinutesLocal(date, time, sessionMinutes);
  const request = {
    request_id: `REQ-${Date.now().toString(36).toUpperCase()}`,
    created_at: new Date().toISOString(),
    queue_type: "booking",
    check_in: false,
    status: "pending_codex_calendar_plugin",
    calendar_id: "primary",
    owner_email: "pierce@fokcus.com",
    guest,
    raw_guest_capture: {
      name: String(body.guest_name || "").trim(),
      email: String(body.guest_email || "").trim()
    },
    capture_corrections: {
      name: normalizedName !== String(body.guest_name || "").trim(),
      email: normalizedEmail !== String(body.guest_email || "").trim()
    },
    date,
    time,
    end_date: end.date,
    end_time: end.time,
    duration_minutes: sessionMinutes,
    timezone: ownerTimezone,
    recording_consent: true
  };

  await mkdir(workDir, { recursive: true });
  await appendFile(bookingRequestsPath, `${JSON.stringify(request)}\n`);

  sendJson(req, res, 200, {
    ok: true,
    request_id: request.request_id,
    queue_type: request.queue_type,
    check_in: request.check_in,
    status: request.status,
    calendar_id: request.calendar_id,
    owner_email: request.owner_email,
    date,
    time,
    end_date: end.date,
    end_time: end.time,
    duration_minutes: sessionMinutes,
    guest_email: guest.email,
    guest_name: guest.name,
    capture_corrections: request.capture_corrections
  });
}

async function handleCheckInRequest(req, res) {
  const body = await readJson(req);
  const normalizedName = normalizeGuestName(body.guest_name);
  const date = String(body.date || todayInPacific()).trim();
  const sessionTime = normalizeTime(body.session_time);

  if (!normalizedName || body.recording_consent !== true) {
    sendJson(req, res, 400, { ok: false, reason: "missing_required_fields" });
    return;
  }

  const checkedInAt = nowInPacific();
  const request = {
    request_id: `CHK-${Date.now().toString(36).toUpperCase()}`,
    created_at: new Date().toISOString(),
    queue_type: "check_in",
    check_in: true,
    status: "pending_codex_calendar_plugin",
    action: "mark_guest_checked_in",
    calendar_id: "primary",
    owner_email: "pierce@fokcus.com",
    guest: {
      name: normalizedName
    },
    raw_guest_capture: {
      name: String(body.guest_name || "").trim()
    },
    capture_corrections: {
      name: normalizedName !== String(body.guest_name || "").trim()
    },
    date,
    session_time: sessionTime || "",
    timezone: ownerTimezone,
    recording_consent: true,
    admin_calendar_note: `Admin note: Guest checked in at ${checkedInAt}.`
  };

  await mkdir(workDir, { recursive: true });
  await appendFile(checkInRequestsPath, `${JSON.stringify(request)}\n`);

  sendJson(req, res, 200, {
    ok: true,
    request_id: request.request_id,
    queue_type: request.queue_type,
    check_in: request.check_in,
    status: request.status,
    action: request.action,
    calendar_id: request.calendar_id,
    owner_email: request.owner_email,
    guest_name: request.guest.name,
    date,
    session_time: request.session_time,
    timezone: request.timezone,
    admin_calendar_note: request.admin_calendar_note,
    capture_corrections: request.capture_corrections
  });
}

function instructionsForMode(mode) {
  if (mode === "check-in") {
    return "You are Pierce, a concise and friendly check-in agent. Speak to guests in plain language only. Do not say technical words like Codex, plugin, API, backend, request ID, tool, or function. Start with: \"Hi, welcome. I can check you in for your session.\" Then immediately get recording consent: \"Quick heads up - this voice session may be recorded and transcribed. Is that okay?\" If they do not consent, politely stop. If they consent, ask only for the name they used to book. Read it back: \"I heard {name}. Is that right?\" Important known spelling hint: Kurling Robinson starts with K, not C. If the guest corrects the name, use the corrected spelling. Only after an explicit yes, call prepare_check_in_request. If they mention a session time naturally, include it, but do not ask for email. After the request is saved, say: \"Thank you. You're checked in. Have a great session.\"";
  }

  return "You are Pierce, a concise and friendly voice calendar agent. Speak to guests in plain language only. Do not say technical words like Codex, plugin, API, backend, request ID, tool, or function. Start with: \"Hi, welcome. I can help book your 15-minute session.\" Then immediately get recording consent: \"Quick heads up - this voice session may be recorded and transcribed. Is that okay?\" If they do not consent, politely stop. If they consent, lead one question at a time: ask for their name, then email, then what the session is about, then the date and time, then confirm the time in Pacific. Ask for phone only if the guest wants a phone call. Spell the email back. Important known spelling hints: Kurling Robinson starts with K, not C; fokcus.com is spelled f-o-k-c-u-s, not focus.com. If the guest spells letters, prefer those letters over the likely word. Before saving the request, read back: \"Okay - I've got {name}, {email}, {date} at {time} Pacific, 15 minutes, about {topic}. Should I check the calendar and send the invite?\" Call prepare_booking_request only after an explicit yes. Never say the event is definitely booked and never give a confirmation code. After the request is saved, say: \"Thank you. You'll get a calendar invitation once your session is booked. Have a great session.\"";
}

async function handleRealtimeSession(req, res) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    send(req, res, 500, "OPENAI_API_KEY is not set.");
    return;
  }

  const sdp = await readRequestBody(req);
  if (!sdp.trim()) {
    send(req, res, 400, "Missing SDP offer.");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const mode = url.searchParams.get("mode") === "check-in" ? "check-in" : "book";

  const session = {
    type: "realtime",
    model: "gpt-realtime-2",
    instructions: instructionsForMode(mode),
    audio: {
      output: {
        voice: "marin"
      }
    }
  };

  const form = new FormData();
  form.set("sdp", sdp);
  form.set("session", JSON.stringify(session));

  const upstream = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  });

  const text = await upstream.text();
  if (!upstream.ok) {
    send(req, res, upstream.status, text);
    return;
  }

  send(req, res, 200, text, "application/sdp");
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    send(req, res, 403, "Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    send(req, res, 200, body, contentTypes[extname(filePath)] || "application/octet-stream");
  } catch {
    send(req, res, 404, "Not found");
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "POST" && url.pathname === "/session") {
      await handleRealtimeSession(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/booking/request") {
      await handleBookingRequest(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/check-in/request") {
      await handleCheckInRequest(req, res);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(req, res);
      return;
    }

    send(req, res, 405, "Method not allowed");
  } catch (error) {
    console.error(error);
    send(req, res, 500, "Internal server error");
  }
});

server.listen(port, host, () => {
  console.log(`Realtime voice agent running at http://${host}:${port}`);
});
