import { shownText, type InlineNode, type MarkdownBlock } from "./markdown.ts";

/**
 * Reference-style links (`[text][label]`, `[label][]`, `[label]` with `[label]: https://… "title"`)
 * in a file's Preview (#3987, #4002). Read over the blocks as they are drawn, once the whole
 * document's structure is final, never on text still arriving (chat does not read them).
 *
 * - A definition is a line a top-level paragraph starts with, drawn as `[label]: `, the autolink
 *   that line already shows, and an optional quoted title. The reference goes where that link went.
 * - A label is read only when that is the one place it is written before a colon: a second
 *   definition, or `[label]:` in a cell, heading, list item, quote, after a paragraph's text or
 *   mid-sentence, leaves every use of it as text. So text shaped as a definition links nothing:
 *   its label is then written before a colon twice, or has no definition.
 * - A definition's line is left out only when a link was drawn from that exact line; a definition
 *   nothing uses stays as written, so no text an agent wrote vanishes.
 * - A visible `<!--` (a comment the HTML reader did not take) turns it all off: a definition may be
 *   meant inside it.
 */
export function readReferenceLinks(blocks: MarkdownBlock[]): MarkdownBlock[] {
  const lines = [...runs(blocks)];
  const drawnLines = lines.map(drawn);
  if (drawnLines.some(({ text }) => text.includes("<!--"))) return blocks;

  const written = new Map<string, number>();
  for (const { text } of drawnLines) {
    for (const match of text.matchAll(DEFINITION_SHAPED)) {
      for (const label of [match[1], match[2]]) {
        if (label) written.set(normalLabel(label), (written.get(normalLabel(label)) ?? 0) + 1);
      }
    }
  }

  const definitions = new Map<string, Definition>();
  const definitionLines = new Set<InlineNode[]>();
  blocks.forEach((block, blockIndex) => {
    if (block.type !== "paragraph") return;
    for (const [lineIndex, line] of block.lines.entries()) {
      const read = definition(line);
      if (read === null) break;
      definitionLines.add(line);
      const label = normalLabel(read.label);
      if (written.get(label) === 1) definitions.set(label, { ...read, blockIndex, lineIndex });
    }
  });
  if (definitions.size === 0) return blocks;

  const used = new Set<Definition>();
  const swaps = new Map<InlineNode, InlineNode[]>();
  lines.forEach((line, at) => {
    if (definitionLines.has(line)) return;
    const { text, atoms } = drawnLines[at]!;
    let resolvedEnd = -1;
    for (const atom of atoms) {
      const pieces: InlineNode[] = [];
      let offset = 0;
      for (const match of atom.node.value.matchAll(REFERENCE)) {
        const start = atom.at + match.index;
        const end = start + match[0].length;
        const before = text[start - 1];
        const after = text[end];
        if (before === "!" || before === "\\" || before === "[" || (before === "]" && start !== resolvedEnd)) continue;
        if (match[2] === undefined && (after === "(" || after === "[" || after === "]")) continue;
        const target = definitions.get(normalLabel(match[2] || match[1]!));
        if (target === undefined) continue;
        used.add(target);
        resolvedEnd = end;
        if (match.index > offset) pieces.push({ type: "text", value: atom.node.value.slice(offset, match.index) });
        const children: InlineNode[] = [{ type: "text", value: match[1]! }];
        pieces.push(target.title ? { type: "link", href: target.href, title: target.title, children } : { type: "link", href: target.href, children });
        offset = match.index + match[0].length;
      }
      if (pieces.length === 0) continue;
      if (offset < atom.node.value.length) pieces.push({ type: "text", value: atom.node.value.slice(offset) });
      swaps.set(atom.node, pieces);
    }
  });
  if (used.size === 0) return blocks;

  const hidden = new Set([...used].map((target) => `${target.blockIndex}:${target.lineIndex}`));
  return swapBlocks(blocks, swaps).flatMap((block, blockIndex): MarkdownBlock[] => {
    if (block.type !== "paragraph") return [block];
    const kept = block.lines.filter((_, lineIndex) => !hidden.has(`${blockIndex}:${lineIndex}`));
    return kept.length === block.lines.length ? [block] : kept.length === 0 ? [] : [{ ...block, lines: kept }];
  });
}

interface Definition { label: string; href: string; title?: string; blockIndex: number; lineIndex: number }
type TextNode = Extract<InlineNode, { type: "text" }>;

// a footnote (`[^1]`) is no label
const LABEL = String.raw`\[(?!\^)([^[\]\n]+)\]`;
const REFERENCE = new RegExp(String.raw`${LABEL}(?:\[([^[\]\n]*)\])?`, "g");
const DEFINITION_SHAPED = new RegExp(String.raw`${LABEL}(?:\[([^[\]\n]*)\])?(?=[ \t]*\\?[:：])`, "g");
const DEFINITION_START = new RegExp(String.raw`^ {0,3}${LABEL}:[ \t]+$`);
const TITLE = /^[ \t]+(?:"([^"\n]*)"|'([^'\n]*)'|\(([^()\n]*)\))[ \t]*$/;

function normalLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/** `[label]: ` then the autolink main draws for the address (its words are its address), then an optional title. */
function definition(line: InlineNode[]): Omit<Definition, "blockIndex" | "lineIndex"> | null {
  const [head, link, tail, ...rest] = line;
  if (rest.length > 0 || head?.type !== "text" || link?.type !== "link" || link.title !== undefined) return null;
  const label = DEFINITION_START.exec(head.value)?.[1];
  const [words, ...more] = link.children;
  if (label === undefined || more.length > 0 || words?.type !== "text" || (link.href !== words.value && link.href !== `https://${words.value}`)) return null;
  if (tail === undefined || (tail.type === "text" && tail.value.trim() === "")) return { label, href: link.href };
  const title = tail.type === "text" ? TITLE.exec(tail.value) : null;
  if (title === null) return null;
  const value = title[1] ?? title[2] ?? title[3] ?? "";
  return value === "" ? { label, href: link.href } : { label, href: link.href, title: value };
}

function* runs(blocks: MarkdownBlock[]): Generator<InlineNode[]> {
  for (const block of blocks) {
    switch (block.type) {
      case "heading": yield block.content; break;
      case "paragraph": yield* block.lines; break;
      case "list":
        for (const item of block.items) {
          yield item.content;
          if (item.blocks !== undefined) yield* runs(item.blocks);
        }
        break;
      case "blockquote": yield* runs(block.blocks); break;
      case "table":
        yield* block.header;
        for (const row of block.rows) yield* row;
        break;
      case "visualization": case "math": case "code": case "hr": break;
    }
  }
}

/** A line's text as drawn, and where each of its text nodes sits in it (emphasis is looked into; a code span, link or picture is not). */
function drawn(line: InlineNode[]): { text: string; atoms: Array<{ node: TextNode; at: number }> } {
  let text = "";
  const atoms: Array<{ node: TextNode; at: number }> = [];
  const walk = (nodes: InlineNode[]): void => {
    for (const node of nodes) {
      switch (node.type) {
        case "text": atoms.push({ node, at: text.length }); text += node.value; break;
        case "strong": case "em": case "del": walk(node.children); break;
        case "link": case "file": text += shownText(node.children) ?? "\ufffc"; break;
        case "code": case "math": case "image": text += "\ufffc"; break;
      }
    }
  };
  walk(line);
  return { text, atoms };
}

function swapNodes(nodes: InlineNode[], swaps: Map<InlineNode, InlineNode[]>): InlineNode[] {
  return nodes.flatMap((node): InlineNode[] => {
    const swap = swaps.get(node);
    if (swap !== undefined) return swap;
    return node.type === "strong" || node.type === "em" || node.type === "del" ? [{ ...node, children: swapNodes(node.children, swaps) }] : [node];
  });
}

function swapBlocks(blocks: MarkdownBlock[], swaps: Map<InlineNode, InlineNode[]>): MarkdownBlock[] {
  return blocks.map((block): MarkdownBlock => {
    switch (block.type) {
      case "heading": return { ...block, content: swapNodes(block.content, swaps) };
      case "paragraph": return { ...block, lines: block.lines.map((line) => swapNodes(line, swaps)) };
      case "list": return { ...block, items: block.items.map((item) => ({ ...item, content: swapNodes(item.content, swaps), ...(item.blocks === undefined ? {} : { blocks: swapBlocks(item.blocks, swaps) }) })) };
      case "blockquote": return { ...block, blocks: swapBlocks(block.blocks, swaps) };
      case "table": return { ...block, header: block.header.map((cell) => swapNodes(cell, swaps)), rows: block.rows.map((row) => row.map((cell) => swapNodes(cell, swaps))) };
      case "visualization": case "math": case "code": case "hr": return block;
    }
  });
}
