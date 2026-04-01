# Doraemon TODO

## Current Goal

- Use Doraemon to:
  - open a YouTube video
  - get the transcript
  - open the Ask Gemini UI

## Findings

- Doraemon can navigate YouTube successfully.
- Doraemon can extract visible page text from the loaded YouTube video page.
- The relay connection is improved enough for real browser work, but it can still flap in the background and make longer command sequences fragile.
- `find` now works on the YouTube watch page and can identify:
  - `Show transcript`
  - `Ask`
  - `Ask questions`
  - Gemini suggestion chips
- `click-text` now works well enough to:
  - open the transcript panel
  - open the Ask/Gemini panel
  - click at least one built-in Gemini suggestion chip
- `youtube-state` correctly detects when transcript and Ask/Gemini are open.
- `youtube-transcript` works, but if Gemini is frontmost it can capture the Gemini panel instead of the transcript body.
- Doraemon can extract Gemini's related-content answer after clicking a built-in suggestion chip.
- Doraemon still cannot reliably target the freeform Gemini input box, which blocks custom question submission.
- Ranking is improved, but cross-panel confusion still happens:
  - a Gemini suggestion click can accidentally target transcript items if labels overlap semantically.
- The old broad `text=...` flow is no longer the right path on YouTube; panel-aware targeting is the right direction.

## Next Work

- Make commands resilient to transient reconnect gaps so multi-step flows do not fail mid-run.
- Add panel-scoped targeting:
  - Gemini panel
  - transcript panel
  - description region
- Add a first-class `youtube-ask "<question>"` flow that:
  - finds the Gemini input reliably
  - types the question
  - submits it
  - extracts the response
- Improve `youtube-transcript` so it prefers transcript content over whichever side panel is currently frontmost.
- Add better candidate filtering so transcript rows do not outrank Gemini chips when the user intent is clearly Gemini-related.
- Add structured extraction for Gemini answers and suggested follow-up resources.
