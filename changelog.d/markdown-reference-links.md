### Fixed
- Markdown previews and chat messages read reference-style links (`[docs][1]`, `[docs][]` and
  `[docs]`, with `[1]: https://x.dev` on a line of its own) as links. A definition's line is left
  out only when a link was drawn from it; one nothing uses stays as written. While an answer is
  still being written, its last block (a paragraph, list, quote or table) links nothing by a
  reference until the next block starts or the answer is done.
