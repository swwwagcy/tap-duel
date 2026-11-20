# Tap Duel

A one-screen host console for a two-card duel: each side shows one card, the higher rank wins.

- Open `index.html` in a browser. No build step, no server.
- Enter cards by tapping suit + rank, with a keyboard-mode IC card reader (13.56MHz), or by tapping IC stickers on an Android phone in Chrome (needs an HTTPS URL).
- Everything runs in the page; settings and the enrolled deck are kept in the browser's local storage.

## Tap Duel Live

`live/` holds the full prototype: a small server for Cloud Run, a viewer page, a host console and a camera card reader that reads cards by itself. See [live/README.md](live/README.md).
