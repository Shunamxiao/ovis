### Fixed
- A Markdown file's Preview reads reference-style links (`[text][label]`, `[label][]`, `[label]`
  with `[label]: https://… "title"`) as links, and leaves out a definition's line only once a link
  was drawn from it. A definition nothing uses, a label defined twice or written before a colon
  elsewhere, and an address that is not a web link stay as written. Chat messages still show them
  as written.
