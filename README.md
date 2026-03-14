# Voice Access Restyler

Voice Access Restyler is a Chrome-compatible Manifest V3 extension plus a local Node service.

- The extension captures voice commands from the popup.
- Smallest Pulse STT transcribes the audio.
- The Claude Agent SDK analyzes the current page snapshot and returns generated CSS plus element-level actions.
- The content script applies reversible HTML/CSS accessibility changes.
- Smallest expressive TTS speaks the response back to the user.

## What it changes

- higher contrast
- larger text
- improved spacing
- highlighted interactive controls
- reduced motion
- focus mode to de-emphasize distracting side regions
- heuristic `aria-label` fixes for unlabeled controls

## Local service

The local service runs at `http://127.0.0.1:8787` and exposes:

- `GET /health`
- `POST /api/voice/transcribe`
- `POST /api/voice/speak`
- `POST /api/agent/page-plan`

`/api/agent/page-plan` uses the [Claude Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview) approach programmatically through `@anthropic-ai/claude-agent-sdk`, with retries and output validation before any generated changes are applied.

## Setup

1. Copy `.env.example` to `.env.local`.
2. Set:
   - `ANTHROPIC_API_KEY`
   - `SMALLEST_API_KEY`
3. Run `npm install`.
4. Run `npm run dev`.
5. Open Chrome extensions.
6. Enable developer mode.
7. Click `Load unpacked`.
8. Select this folder.

## Usage

1. Open any website.
2. Open the extension popup.
3. Click `Start voice command`.
4. Say something like:
   - "Make this page easier to read"
   - "Increase contrast and highlight the buttons"
   - "Read the important parts of this page"
   - "Change this UI to feel more like YouTube"
   - "Change this UI to feel more like Spotify"
   - "What are the most important actions on this page?"

## Voice stack

- Smallest STT cookbook reference: [speech-to-text getting started](https://github.com/smallest-inc/cookbook/tree/main/speech-to-text/getting-started)
- Smallest expressive TTS cookbook reference: [expressive-tts](https://github.com/smallest-inc/cookbook/tree/main/text-to-speech/expressive-tts)

## Notes

- The extension is load-unpacked and does not need a frontend build step.
- The Claude agent is API-backed. The local service is only a thin wrapper for the extension.
- Accessibility fixes are reversible and validated before application.
- The agent generates page-specific CSS and node actions instead of selecting from hardcoded visual presets.
