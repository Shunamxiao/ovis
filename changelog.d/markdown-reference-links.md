### Fixed
- A Markdown file's Preview reads reference-style links (`[docs][1]`, `[docs][]` and `[docs]`, with
  `[1]: https://x.dev` on a line of its own) as links. A definition's line is left out only when a
  link was drawn from it; one nothing uses stays as written. Chat messages keep reference-style
  links as written, each definition with its address in view.
