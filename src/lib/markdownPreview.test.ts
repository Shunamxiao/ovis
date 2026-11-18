import { describe, expect, it } from "bun:test";

import { knownPreview, parsePreviewOffThread } from "./markdownPreview.ts";

describe("parsePreviewOffThread", () => {
  it("parses in a real worker and remembers the file", async () => {
    const text = "# Plan\n\n- [x] done\n- [ ] open\n";
    const blocks = await parsePreviewOffThread(text).promise;
    expect(blocks?.[0]).toMatchObject({ type: "heading", level: 1 });
    expect(blocks?.[1]).toMatchObject({ type: "list" });
    expect(knownPreview(text)).toBe(blocks!);
    expect(knownPreview("# another file")).toBeUndefined();
  });

  it("draws a reference-style link and leaves out the definition it came from (#3987)", async () => {
    const text = "This is a [reference link][1].\nThis is another [reference link][link-name].\n\n[1]: https://www.google.com\n[link-name]: https://www.google.com \"Google!\"\n";
    const blocks = await parsePreviewOffThread(text).promise;
    expect(blocks).toEqual([{ type: "paragraph", lines: [
      [{ type: "text", value: "This is a " }, { type: "link", href: "https://www.google.com", children: [{ type: "text", value: "reference link" }] }, { type: "text", value: "." }],
      [{ type: "text", value: "This is another " }, { type: "link", href: "https://www.google.com", title: "Google!", children: [{ type: "text", value: "reference link" }] }, { type: "text", value: "." }],
    ] }]);
  });

});
