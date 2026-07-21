# Pierce Realtime WebRTC Voice Agent

Small local browser app using the OpenAI Realtime API, WebRTC, and `gpt-realtime-2`.
Pierce helps collect a 15-minute booking request and can check in a guest by booking name. For this phase, Codex creates or updates the real Google Calendar event through the connected Google Calendar plugin.

## Setup

1. Use Node.js 20 or newer.
2. Set your OpenAI API key:

   ```bash
   export OPENAI_API_KEY="sk-..."
   ```

3. Start the server:

   ```bash
   npm start
   ```

4. Open http://localhost:3000, choose `Book Session` or `Check In`, and allow microphone access.

## What It Does

- The browser captures microphone audio and plays model audio with `RTCPeerConnection`.
- The browser creates an `oai-events` data channel.
- The server accepts the browser SDP at `POST /session`.
- The server forwards that SDP to `https://api.openai.com/v1/realtime/calls` using multipart `FormData` fields named `sdp` and `session`.
- In booking mode, the browser registers `prepare_booking_request(guest_name, guest_email, topic, timezone_confirm, recording_consent, date, time, phone)` with `session.update`.
- In check-in mode, the browser registers `prepare_check_in_request(guest_name, recording_consent, date, session_time)` with `session.update`.
- Pierce collects name, email, topic, timezone confirmation, optional phone, recording consent, then asks for explicit confirmation before saving the request.
- Pierce starts with "Hi, welcome," gets recording consent first, leads one question at a time, and closes with: "Thank you. You'll get a calendar invitation once your session is booked. Have a great session."
- The local app writes pending requests to `work/booking-requests.jsonl`.
- Check-ins ask only for recording consent and the booking name, then write pending admin updates to `work/check-in-requests.jsonl`.
- Queue records include `queue_type` and a `check_in` flag: bookings use `check_in: false`; check-ins use `check_in: true`.
- A check-in record includes an admin calendar note like `Admin note: Guest checked in at Jul 21, 2026, 1:05 PM.`
- Spoken emails such as `jane at example dot com` are normalized and validated before a request is saved.
- Known capture corrections handle recurring misses like `Curling Robinson` -> `Kurling Robinson` and `focus.com` -> `fokcus.com`.
- Codex fulfills pending requests with the connected Google Calendar plugin: check availability first, create booking events with `sendUpdates=all`, and mark matched check-in events with the admin note.

## Calendar Auth

No `GOOGLE_CALENDAR_ACCESS_TOKEN` is needed in this phase. Calendar access stays inside Codex/plugin tools connected to `pierce@fokcus.com`; the local browser app never receives Google OAuth credentials and never writes directly to Google Calendar.

After Pierce captures a booking request, ask Codex to complete the latest booking request. Codex will read `work/booking-requests.jsonl`, check Pierce's calendar with the plugin, and create the invite only if the slot is free.

After Pierce captures a check-in, ask Codex to complete the latest check-in. Codex will read `work/check-in-requests.jsonl`, find the matching event on Pierce's calendar, and add the admin check-in note to the event description.
