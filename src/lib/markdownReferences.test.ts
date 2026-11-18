import { describe, expect, it } from "bun:test";
import { parseInline, parseMarkdown, type InlineNode, type MarkdownBlock } from "../../shared/markdown.ts";
import { readReferenceLinks } from "./markdownReferences.ts";

const preview = (source: string): MarkdownBlock[] => readReferenceLinks(parseMarkdown(source, 0, true));
const link = (href: string, words: string, title?: string): InlineNode => ({ type: "link", href, ...(title ? { title } : {}), children: [{ type: "text", value: words }] });

function lines(blocks: MarkdownBlock[]): InlineNode[][] {
  return blocks.flatMap((block): InlineNode[][] => {
    switch (block.type) {
      case "heading": return [block.content];
      case "paragraph": return block.lines;
      case "list": return block.items.flatMap((item) => [item.content, ...lines(item.blocks ?? [])]);
      case "blockquote": return lines(block.blocks);
      case "table": return [...block.header, ...block.rows.flat()];
      default: return [];
    }
  });
}
function words(nodes: InlineNode[]): string {
  return nodes.map((node) => {
    switch (node.type) {
      case "text": case "code": case "math": return node.value;
      case "strong": case "em": case "del": case "link": case "file": return words(node.children);
      case "image": return node.alt;
    }
  }).join("");
}
function links(nodes: InlineNode[]): Array<Extract<InlineNode, { type: "link" }>> {
  return nodes.flatMap((node) => node.type === "link" ? [node] : "children" in node ? links(node.children) : []);
}

describe("reference links in a Preview", () => {
  it("draws a reference as the inline link it stands for, and keeps every definition on screen", () => {
    const source = "[the docs][Docs], [docs][] and [DOCS], [site].\n\n[docs]: https://d.dev 'Read me'\n[site]: <www.s.dev>";
    expect(preview(source)).toEqual([
      { type: "paragraph", lines: [[link("https://d.dev", "the docs", "Read me"), { type: "text", value: ", " }, link("https://d.dev", "docs", "Read me"), { type: "text", value: " and " }, link("https://d.dev", "DOCS", "Read me"), { type: "text", value: ", " }, link("https://www.s.dev", "site"), { type: "text", value: "." }]] },
      parseMarkdown(source, 0, true)[1]!,
    ]);
    expect(lines(preview(source))[0]![0]).toEqual(parseInline("[the docs](https://d.dev 'Read me')")[0]);
    const blocks = preview("# See [a]\n\n> quoted [a]\n\n- item [a]\n\n| [a] | **[a][b]** |\n|---|---|\n\n[a]: https://a.dev\n[b]: www.b.dev");
    expect(lines(blocks).flatMap(links).map((drawn) => drawn.href)).toEqual(["https://a.dev", "https://a.dev", "https://a.dev", "https://a.dev", "https://www.b.dev", "https://a.dev", "https://www.b.dev"]);
  });

  it("reads a definition whose label appears elsewhere in emphasis or code before a colon", () => {
    expect(preview("See [r].\n\n[r]: https://r.dev\n\n**[r]**: the reference, `[r]`: in code")[0]).toEqual({ type: "paragraph", lines: [[{ type: "text", value: "See " }, link("https://r.dev", "r"), { type: "text", value: "." }]] });
  });

  it("caps a label, not a reference's words, at 999 characters", () => {
    expect(lines(preview(`[${"w".repeat(1000)}][r] [${"a".repeat(998)}😀]\n\n[r]: https://r.dev\n\n[${"a".repeat(998)}😀]: https://e.dev`)).flatMap(links).map((drawn) => drawn.href))
      .toEqual(["https://r.dev", "https://e.dev", "https://r.dev", "https://e.dev"]);
  });

  it("reads a reference whose words hold emphasis or code, and references side by side", () => {
    expect(preview("[**bold** words][r] and [`api()`][r].\n\n[r]: https://r.dev")[0]).toEqual({ type: "paragraph", lines: [[
      { type: "link", href: "https://r.dev", children: [{ type: "strong", children: [{ type: "text", value: "bold" }] }, { type: "text", value: " words" }] },
      { type: "text", value: " and " },
      { type: "link", href: "https://r.dev", children: [{ type: "code", value: "api()" }] },
      { type: "text", value: "." },
    ]] });
    expect(preview("[a][x][b][y] [**c**][x] [**d**][y]\n\n[x]: https://x.dev\n[y]: https://y.dev")[0]).toEqual({ type: "paragraph", lines: [[
      link("https://x.dev", "a"), link("https://y.dev", "b"), { type: "text", value: " " },
      { type: "link", href: "https://x.dev", children: [{ type: "strong", children: [{ type: "text", value: "c" }] }] }, { type: "text", value: " " },
      { type: "link", href: "https://y.dev", children: [{ type: "strong", children: [{ type: "text", value: "d" }] }] },
    ]] });
    expect(preview("[**x** a[b][r]\n\n[r]: https://r.dev")[0]).toEqual({ type: "paragraph", lines: [[
      { type: "text", value: "[" }, { type: "strong", children: [{ type: "text", value: "x" }] }, { type: "text", value: " a" }, link("https://r.dev", "b"),
    ]] });
  });

  it.each([
    ["a label defined twice, also when one has no web address", "[docs] [a]\n\n[docs]: https://good.example\n[DOCS]: https://other.example\n\n[a]: ./notes.md\n[a]: https://y.dev"],
    ["a definition holding markup or an unclosed bracket", "[a] [b] [c]\n\n[a]: x.dev/_a_/b\n\n[b]: https://x.dev \"the *one* page\"\n\n[c]: <https://c.dev"],
    ["a definition holding a reference, or defined again by a line not read", "[go][r] [a] [b] [c]\n\n[r]: localhost/[path][s]\n[s]: https://s.example\n\n[a]: https://x.dev \"the *one* page\"\n\n[a]: https://y.dev\n\n[b]: https://x.dev>\n\n[b]: https://y.dev\n\n[c]: file:///etc/passwd\n\n[c]: https://y.dev"],
    ["a footnote through formatting, a blank label in a reference, or a shortcut before a bracket", "[^**note**][r] [x][ ] [**b**][ ] [a][ [a]]\n\n[r]: https://r.example\n\n[ ]: https://x.dev\n\n[a]: https://a.dev"],
    ["a label longer than 999 characters", `[${"a".repeat(1000)}] [x][${" ".repeat(999)}a] [${" ".repeat(999)}a] [${" ".repeat(999)}a][]\n\n[${"a".repeat(1000)}]: https://a.dev\n\n[a]: https://a.dev`],
    ["an address that is no web address", "[a] [b] [c] [d]\n\n[a]: ssh://h/x\n[b]: tel:123\n[c]: ./notes.md\n[d]: N/A"],
    ["a definition in a list item, a quote, a heading, a cell or after a paragraph's text", "- [a]: https://a.example\n\n> [b]: https://b.example\n\n# [c]: https://c.example\n\n| [d]: https://d.example |\n|---|\n\ntext\n[e]: https://e.example\n\n[a] [b] [c] [d] [e]"],
    ["a reference followed by a colon", "[r]: https://r.dev\n\n| [r]: https://wrong.example | x |\n|---|---|\n\nx [r]: y, [x][r] : y, [r][]:"],
    ["a footnote", "Bun[^1].\n\n[^1]: https://bun.sh"],
    ["a linked badge", "[![build][badge]][ci]\n\n[badge]: https://img.dev/b.svg\n[ci]: https://ci.dev"],
    ["a reference before a parenthesis or bracket, or after a bracket, a backslash or `!`", "[a](x [[a]] \\[a] ![a] ![**b**][a]\n\n[a]: https://a.dev"],
    ["a blank label or words", "Tick [ ] when done, [ ][r].\n\n[ ]: https://x.example\n\n[r]: https://r.example"],
    ["a reference in code or a formula", "`[r]` $[r]$\n\n[r]: https://r.example"],
    ["a reference whose words hold a link or a bracket", "[see https://x.dev][r] [**a]**][r]\n\n[r]: https://r.dev"],
  ])("leaves %s as written", (_, source) => {
    expect(preview(source)).toEqual(parseMarkdown(source, 0, true));
  });

  it("reads a long line with a bracket that never closes, or a label defined on every line, in time that grows with the file", () => {
    // 320 KB: a search that tried every split of such a line took over a minute; the same label defined
    // again on every line copied a growing list each time and took 7 s; both are now under a second
    for (const source of [`[${"a ".repeat(160_000)}\n\nx [${"a".repeat(320_000)}\n\n[a]: https://a.dev`, `[a]\n\n${"[a]: x\n".repeat(50_000)}`]) {
      const blocks = parseMarkdown(source, 0, true);
      const start = performance.now();
      readReferenceLinks(blocks);
      expect(performance.now() - start).toBeLessThan(3_000);
    }
  });

  it("draws only links to an address on screen, and changes nothing else (generated documents)", () => {
    const labels = ["a", "A", "b", "docs", "Docs", "^1", " "];
    let state = 7;
    const random = (count: number): number => { state = (state * 1103515245 + 12345) % 2 ** 31; return (state >>> 12) % count; };
    let read = 0;
    for (let document = 0; document < 4000; document += 1) {
      let url = 0;
      const piece = (): string => {
        const label = labels[random(labels.length)]!;
        const address = (): string => `https://u${url++}.dev`;
        const pieces = [
          `[${label}]: ${address()}`, `[${label}]: ${address()} "t"`, `[${label}]: <${address()}>`, `see [${label}] now`, `[x ${label}][${label}]`, `[${label}][]`,
          `[**x** ${label}][${label}]`, `[\`x\` ${label}][${label}]`, `[${label}]: ssh://h/x`, `![i][${label}]`, `**[${label}]**: ${address()}`, `\`[${label}]\``, `[${label}] (${address()})`,
        ];
        return pieces[random(2) === 0 ? random(8) : random(pieces.length)]!;
      };
      const opener = ["", "", "", "# ", "> ", "- ", "    ", "| ", "1. "];
      const swallow = ["<!--", "-->", "```", "$$", "`", "\\(", "\\)", "|---|---|", "**"];
      const sourceLines: string[] = [];
      for (let line = random(8) + 2; line > 0; line -= 1) {
        if (random(4) === 0) sourceLines.push("");
        const many = random(3) === 0 ? ` ${piece()}` : "";
        sourceLines.push(random(6) === 0 ? swallow[random(swallow.length)]! : opener[random(opener.length)]! + piece() + many);
      }
      const source = sourceLines.join("\n");
      const main = parseMarkdown(source, 0, true);
      const out = readReferenceLinks(main);
      const before = lines(main);
      const after = lines(out);
      const reference = (drawn: Extract<InlineNode, { type: "link" }>): boolean => words(drawn.children) !== drawn.href && !before.flat().includes(drawn);
      const references = after.flatMap(links).filter(reference);
      if (references.length === 0) { expect(out).toBe(main); continue; }
      read += 1;
      expect(after.length).toBe(before.length);
      const shown = after.flatMap(links).filter((drawn) => !reference(drawn)).map((drawn) => drawn.href);
      for (const drawn of references) expect(shown).toContain(drawn.href);
      after.forEach((line, at) => {
        const was = Array.from(words(before[at]!));
        let i = 0;
        for (const char of words(line)) {
          while (i < was.length && was[i] !== char) { expect(`[]${labels.join("")}`).toContain(was[i]!); i += 1; }
          i += 1;
        }
        for (const char of was.slice(i)) expect(`[]${labels.join("")}`).toContain(char);
      });
    }
    expect(read).toBeGreaterThan(120);
  });
});
