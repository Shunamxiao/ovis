### Fixed
- A Markdown file's Preview draws reference-style links (`[text][label]`, `[label][]`, `[label]`
  with `[label]: https://… "title"`) as the inline links they stand for. Every definition line
  stays on screen as written, so each address a reference goes to is visible; a label defined
  twice and an address that is not a web address stay as written. Chat messages still show
  reference links as written.
