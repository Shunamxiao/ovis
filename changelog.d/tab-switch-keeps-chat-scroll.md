### Fixed
- Switching tabs no longer flashes a chat and scrolls it from the oldest message to the newest:
  the pane frames keep the order they were mounted in, so React moves none of them and the
  scrollTop of what a moved frame scrolled is no longer reset to 0.
