import { describe, expect, it } from "bun:test";
import { parseMarkdown, type InlineNode, type MarkdownBlock } from "../../shared/markdown.ts";
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
  it("reads full, collapsed, shortcut and case-folded references wherever text is drawn", () => {
    expect(preview("[the docs][Docs], [docs][] and [DOCS].\n\n[docs]: https://d.dev 'Read me'")).toEqual([
      { type: "paragraph", lines: [[link("https://d.dev", "the docs", "Read me"), { type: "text", value: ", " }, link("https://d.dev", "docs", "Read me"), { type: "text", value: " and " }, link("https://d.dev", "DOCS", "Read me"), { type: "text", value: "." }]] },
    ]);
    const blocks = preview("# See [a]\n\n> quoted [a]\n\n- item [a]\n\n| [a] | **[a][b]** |\n|---|---|\n\n[a]: https://a.dev\n[b]: www.b.dev");
    expect(lines(blocks).flatMap(links).map((drawn) => drawn.href)).toEqual(["https://a.dev", "https://a.dev", "https://a.dev", "https://a.dev", "https://www.b.dev"]);
    expect(blocks.at(-1)?.type).toBe("table");
  });

  it("reads a reference whose text holds emphasis or code", () => {
    expect(preview("[**bold** words][r] and [`api()`][r].\n\n[r]: https://r.dev")).toEqual([{ type: "paragraph", lines: [[
      { type: "link", href: "https://r.dev", children: [{ type: "strong", children: [{ type: "text", value: "bold" }] }, { type: "text", value: " words" }] },
      { type: "text", value: " and " },
      { type: "link", href: "https://r.dev", children: [{ type: "code", value: "api()" }] },
      { type: "text", value: "." },
    ]] }]);
    expect(preview("[**x** a[b][r]\n\n[r]: https://r.dev")).toEqual([{ type: "paragraph", lines: [[
      { type: "text", value: "[" }, { type: "strong", children: [{ type: "text", value: "x" }] }, { type: "text", value: " a" }, link("https://r.dev", "b"),
    ]] }]);
  });

  it("reads references side by side, and the definition a hidden comment held is not one", () => {
    expect(preview("See [Mozilla CoC].\n\n[mozilla  coc]: https://m.dev")).toEqual([{ type: "paragraph", lines: [[{ type: "text", value: "See " }, link("https://m.dev", "Mozilla CoC"), { type: "text", value: "." }]] }]);
    expect(preview("[a][x][b][y]\n\n[x]: https://x.dev\n[y]: https://y.dev")).toEqual([{ type: "paragraph", lines: [[link("https://x.dev", "a"), link("https://y.dev", "b")]] }]);
    expect(preview("<!--\n\n[docs]: https://wrong.example\n\n-->\n\n[docs]: https://right.example\n\n[docs]")).toEqual([{ type: "paragraph", lines: [[link("https://right.example", "docs")]] }]);
  });

  it("keeps a definition nothing used, and the text after the definitions a paragraph starts with", () => {
    expect(preview("[a]\n\n[a]: https://a.dev\n[b]: https://b.dev\nmore text")).toEqual([
      { type: "paragraph", lines: [[link("https://a.dev", "a")]] },
      { type: "paragraph", lines: [[{ type: "text", value: "[b]: " }, link("https://b.dev", "https://b.dev")], [{ type: "text", value: "more text" }]] },
    ]);
  });

  // #4002's reproduced failures and the forms around them: each draws exactly what it drew before
  it.each([
    ["a definition only a visible comment could hold", "<!--\n\n[docs]: https://hidden.example\n\n-->\n\nRead [docs]."],
    ["an indented comment, drawn as text", "    <!--\n\n[docs]: https://hidden.example\n\n-->\n\n[docs]"],
    ["definition-shaped text in a table cell", "| [r]: https://wrong.example | x |\n|---|---|\n\n[r]: https://right.example\n\n[r]"],
    ["definition-shaped text in a heading", "# [r]: https://wrong.example\n\n[r]: https://right.example\n\n[r]"],
    ["definition-shaped text in a list item, a quote or after a paragraph's text", "- [r]: https://a.example\n\n> [s]: https://b.example\n\ntext\n[t]: https://c.example\n\n[r] [s] [t]"],
    ["definition-shaped text in emphasis, after a reference or mid-sentence", "**[r]**: https://wrong.example\n\n[x][s]: https://wrong.example\n\nsee [t] : here\n\n[r]: https://right.example\n[s]: https://right.example\n[t]: https://right.example\n\n[r] [s] [t]"],
    ["a backtick in a label", "[`a]: ssh://h/x\n\n[`a] and [docs] `\n\n[docs]: https://d.dev"],
    ["a formula opened in a label", "[\\(a]: ssh://h/x\n\nsee [\\(a] and [docs] \\) ok\n\n[docs]: https://d.dev"],
    ["a label defined twice", "[docs]\n\n[docs]: https://good.example\n[DOCS]: https://other.example"],
    ["an address that can't be a link", "[a] [b]\n\n[a]: ssh://h/x\n[b]: tel:123"],
    ["a definition whose link shows another address", "[r]\n\n[r]: [https://shown.dev](https://other.dev)"],
    ["an HTML link that is no web address", '<p>[r]: <a href="mailto:a@b.dev">mailto:a@b.dev</a></p>\n\n[r]'],
    ["definition-shaped text in a code span or a code block", "[r]: https://good.example\n\n`[r]`: https://evil.example\n\n```\n[s]: https://evil.example\n```\n\n[s]: https://good.example\n\n[r] [s]"],
    ["a second definition that only looks the same (a zero-width character, an accent written apart, a Cyrillic letter)", "See [docs] and [café].\n\n[docs]: https://evil.example\n[café]: https://evil.example\n\n[do\u200bcs]: https://a.example\n[cafe\u0301]: https://b.example\n\n[d\u043ecs]: https://c.example"],
    ["definition-shaped text before a look-alike colon or space", "See [a] [b] [c] [d].\n\n[a]: https://evil.example\n[b]: https://evil.example\n[c]: https://evil.example\n[d]: https://evil.example\n\n[a]\u00a0: https://a.example\n\n[b]\u200b: https://b.example\n\n[c]\u2236 https://c.example\n\n\uff3bd\uff3d\uff1a https://d.example"],
    ["a blank label", "Tick [ ] when done.\n\n[ ]: https://x.example"],
    ["a comment shown as code", "`<!--`\n\n[docs]: https://d.dev\n\n[docs]"],
    ["a reference whose text holds a link or a bracket", "[see https://x.dev][r] [**a]**][r]\n\n[r]: https://r.dev"],
    ["a title holding emphasis", "[r]\n\n[r]: https://a.dev \"**[s]**\""],
    ["a linked badge", "[![build][badge]][ci]\n\n[badge]: https://img.dev/b.svg\n[ci]: https://ci.dev"],
    ["a footnote", "Bun[^1].\n\n[^1]: https://bun.sh"],
    ["a reference before a parenthesis, after a bracket, a backslash or `!`", "[a](x [[a]] \\[a] ![a]\n\n[a]: https://a.dev"],
  ])("leaves %s as written", (_, source) => {
    expect(preview(source)).toEqual(parseMarkdown(source, 0, true));
  });

  it("hides only a definition a drawn link came from, and links no label written before a colon elsewhere (generated documents)", () => {
    const labels = ["a", "A", "b", "docs", "Docs", "^1"];
    let state = 7;
    const random = (count: number): number => { state = (state * 1103515245 + 12345) % 2 ** 31; return (state >>> 12) % count; };
    let read = 0;
    for (let document = 0; document < 4000; document += 1) {
      let url = 0;
      const pieces = (): string => {
        const label = labels[random(labels.length)]!;
        const address = (): string => `https://u${url++}.dev`;
        const pieces = [
          `[${label}]: ${address()}`, `[${label}]: ${address()} "t"`, `[${label}]: <${address()}>`, `[${label}]: ssh://h/x`,
          `see [${label}] now`, `[x ${label}][${label}]`, `[${label}][]`, `![i][${label}]`, `**[${label}]**: ${address()}`,
          `[**x** ${label}][${label}]`, `[\`x\` ${label}][${label}]`,
          `[x ${label}][${label}]: ${address()}`, `\`[${label}]\`: ${address()}`, `[${label}] (${address()})`,
          `[${label}\u200b]: ${address()}`, `[${label}]\u00a0: ${address()}`,
        ];
        // definitions and references twice as often as the forms that must stay text
        return pieces[random(2) === 0 ? random(9) : random(pieces.length)]!;
      };
      const opener = ["", "", "", "# ", "> ", "- ", "    ", "| ", "1. "];
      const swallow = ["<!--", "-->", "```", "$$", "`", "\\(", "\\)", "|---|---|", "**"];
      const sourceLines: string[] = [];
      for (let line = random(8) + 2; line > 0; line -= 1) {
        if (random(4) === 0) sourceLines.push("");
        sourceLines.push(random(6) === 0 ? swallow[random(swallow.length)]! : opener[random(opener.length)]! + pieces());
      }
      const source = sourceLines.join("\n");
      const main = parseMarkdown(source, 0, true);
      const out = readReferenceLinks(main);
      const mainLines = lines(main);
      const outLines = lines(out);
      const address = (drawn: Extract<InlineNode, { type: "link" }>): boolean => words(drawn.children) === drawn.href;
      const shown = new Set(outLines.flatMap(links).filter(address).map((drawn) => drawn.href));
      const references = outLines.flatMap(links).filter((drawn) => !address(drawn));
      if (references.length === 0) { expect(out).toEqual(main); continue; }
      read += 1;
      const hidden = mainLines.filter((line) => links(line).some((drawn) => address(drawn) && !shown.has(drawn.href)));
      expect(outLines.length).toBe(mainLines.length - hidden.length);
      for (const line of hidden) {
        const drawn = links(line).find(address)!;
        expect(main.some((block) => block.type === "paragraph" && block.lines.includes(line))).toBe(true);
        expect(references.some((reference) => reference.href === drawn.href)).toBe(true);
      }
      const text = mainLines.map(words).join("\n");
      for (const reference of references) {
        const label = words(reference.children).split(" ").at(-1)!.toLowerCase();
        const beforeColon = text.match(new RegExp(String.raw`\[(?:[^\]\n]* )?${label.replace("^", "\\^")}\](?:\[[^\]\n]*\])?[ \t]*\\?:`, "gi")) ?? [];
        expect(beforeColon).toHaveLength(1);
        const definition = hidden.find((line) => links(line).some((drawn) => drawn.href === reference.href))!;
        expect(words(definition).toLowerCase().startsWith(`[${label}]:`)).toBe(true);
      }
      // nothing vanished but the hidden lines and a reference's brackets and label
      const kept = mainLines.filter((line) => !hidden.includes(line)).map(words).join("\n").replace(/[[\]]/g, "");
      const after = outLines.map(words).join("\n").replace(/[[\]]/g, "");
      let at = 0;
      for (const char of after) {
        while (at < kept.length && kept[at] !== char) { expect(labels.join("")).toContain(kept[at]!); at += 1; }
        at += 1;
      }
      expect(at).toBeLessThanOrEqual(kept.length);
      for (const char of kept.slice(at)) expect(labels.join("")).toContain(char);
    }
    expect(read).toBeGreaterThan(100);
  });
});
