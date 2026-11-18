import { shownText, type InlineNode, type MarkdownBlock } from "../../shared/markdown.ts";
import { skeleton } from "./lookalike.ts";

/**
 * Reference-style links (`[text][label]`, `[label][]`, `[label]` with `[label]: https://… "title"`)
 * in a file's Preview (#3987, #4002). Read over the blocks as they are drawn, once the whole
 * document's structure is final, never on text still arriving (chat does not read them).
 *
 * - A definition is a line a top-level paragraph starts with, drawn as `[label]: `, the http(s)
 *   autolink that line already shows, and an optional quoted title. The reference goes where that
 *   link went.
 * - A label is read only when that is the one place it is written before a colon in everything
 *   drawn, code included: a second definition, or `[label]:` in a cell, heading, list item, quote,
 *   code span or block, after a paragraph's text or mid-sentence, leaves every use of it as text.
 *   So text shaped as a definition links nothing: its label is then written before a colon twice,
 *   or has no definition.
 * - A definition's line is left out only when a link was drawn from that exact line; a definition
 *   nothing uses stays as written, so no text an agent wrote vanishes.
 * - A visible `<!--` (a comment the HTML reader did not take, or one shown as code) turns it all
 *   off: a definition may be meant inside it.
 */
export function readReferenceLinks(blocks: MarkdownBlock[]): MarkdownBlock[] {
  const lines = [...runs(blocks)];
  const drawnLines = lines.map(drawn);
  if (drawnLines.some(({ text }) => text.includes("<!--"))) return blocks;

  // counted by how a label looks (skeleton: case, width, accents written apart, invisible characters and
  // letters drawn like Latin ones folded), before anything that looks like a colon
  const written = new Map<string, number>();
  for (const { text } of drawnLines) {
    for (const match of text.normalize("NFKC").matchAll(DEFINITION_SHAPED)) {
      for (const label of [match[1], match[2]]) {
        if (label) written.set(skeleton(label), (written.get(skeleton(label)) ?? 0) + 1);
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
      const looks = skeleton(read.label);
      if (looks !== "" && written.get(looks) === 1) definitions.set(label, { ...read, blockIndex, lineIndex });
    }
  });
  if (definitions.size === 0) return blocks;

  const used = new Set<Definition>();
  const resolved = new Map<InlineNode[], InlineNode[]>();
  lines.forEach((line, at) => {
    if (definitionLines.has(line)) return;
    const { text, offsets } = drawnLines[at]!;
    let resolvedEnd = -1;
    const opens = (start: number): boolean => {
      const before = text[start - 1];
      return !(before === "!" || before === "\\" || before === "[" || (before === "]" && start !== resolvedEnd));
    };
    const linkTo = (target: Definition, children: InlineNode[]): InlineNode => {
      used.add(target);
      return target.title ? { type: "link", href: target.href, title: target.title, children } : { type: "link", href: target.href, children };
    };
    /** `[` + marks without brackets or links (`**x**`, `` `x` ``) + `][label]` in the next text node of the same line that holds a bracket. */
    const across = (nodes: InlineNode[], k: number, value: string, open: number): { link: InlineNode; closer: number; rest: string; restAt: number } | null => {
      if (!opens(offsets.get(nodes[k]!)! + open)) return null;
      let j = k + 1;
      while (j < nodes.length && plain(nodes[j]!)) j += 1;
      const closer = nodes[j];
      if (j === k + 1 || closer?.type !== "text") return null;
      const close = closer.value.indexOf("]");
      const match = close === -1 || closer.value.lastIndexOf("[", close) !== -1 ? null : CLOSES_ACROSS.exec(closer.value.slice(close));
      const target = match === null ? undefined : definitions.get(normalLabel(match[1]!));
      if (match === null || target === undefined) return null;
      resolvedEnd = offsets.get(closer)! + close + match[0].length;
      const words = value.slice(open + 1);
      const children: InlineNode[] = [...(words === "" ? [] : [{ type: "text" as const, value: words }]), ...nodes.slice(k + 1, j), ...(close === 0 ? [] : [{ type: "text" as const, value: closer.value.slice(0, close) }])];
      return { link: linkTo(target, children), closer: j, rest: closer.value.slice(close + match[0].length), restAt: resolvedEnd };
    };
    const resolve = (nodes: InlineNode[]): InlineNode[] => {
      const out: InlineNode[] = [];
      const push = (node: InlineNode): void => {
        const last = out.at(-1);
        if (node.type === "text" && last?.type === "text") out[out.length - 1] = { type: "text", value: last.value + node.value };
        else if (node.type !== "text" || node.value !== "") out.push(node);
      };
      for (let k = 0; k < nodes.length; k += 1) {
        const node = nodes[k]!;
        if (node.type === "strong" || node.type === "em" || node.type === "del") { out.push({ ...node, children: resolve(node.children) }); continue; }
        if (node.type !== "text") { out.push(node); continue; }
        let value = node.value;
        let at = offsets.get(node)!;
        for (;;) {
          let offset = 0;
          for (const match of value.matchAll(REFERENCE)) {
            const start = at + match.index;
            const end = start + match[0].length;
            const after = text[end];
            if (!opens(start) || (match[2] === undefined && (after === "(" || after === "[" || after === "]"))) continue;
            const target = definitions.get(normalLabel(match[2] || match[1]!));
            if (target === undefined) continue;
            push({ type: "text", value: value.slice(offset, match.index) });
            push(linkTo(target, [{ type: "text", value: match[1]! }]));
            resolvedEnd = end;
            offset = match.index + match[0].length;
          }
          const open = value.lastIndexOf("[");
          const crossed = open >= offset && !value.includes("]", open) ? across(nodes, k, value, open) : null;
          if (crossed === null) { push({ type: "text", value: value.slice(offset) }); break; }
          push({ type: "text", value: value.slice(offset, open) });
          push(crossed.link);
          k = crossed.closer;
          value = crossed.rest;
          at = crossed.restAt;
        }
      }
      return out;
    };
    resolved.set(line, resolve(line));
  });
  if (used.size === 0) return blocks;

  const hidden = new Set([...used].map((target) => `${target.blockIndex}:${target.lineIndex}`));
  return swapBlocks(blocks, resolved).flatMap((block, blockIndex): MarkdownBlock[] => {
    if (block.type !== "paragraph") return [block];
    const kept = block.lines.filter((_, lineIndex) => !hidden.has(`${blockIndex}:${lineIndex}`));
    return kept.length === block.lines.length ? [block] : kept.length === 0 ? [] : [{ ...block, lines: kept }];
  });
}

interface Definition { label: string; href: string; title?: string; blockIndex: number; lineIndex: number }

// a footnote (`[^1]`) is no label
const LABEL = String.raw`\[(?!\^)([^[\]\n]+)\]`;
const REFERENCE = new RegExp(String.raw`${LABEL}(?:\[([^[\]\n]*)\])?`, "g");
const CLOSES_ACROSS = new RegExp(String.raw`^\]${LABEL}`);
const DEFINITION_SHAPED = new RegExp(String.raw`${LABEL}(?:\[([^[\]\n]*)\])?(?=[\s\p{Cf}\p{Default_Ignorable_Code_Point}\\]*[:∶꞉ꓽ˸ː։׃܃܄᛬᠃᠉⁚ःઃ])`, "gu");
const DEFINITION_START = new RegExp(String.raw`^ {0,3}${LABEL}:[ \t]+$`);
const TITLE = /^[ \t]+(?:"([^"\n]*)"|'([^'\n]*)'|\(([^()\n]*)\))[ \t]*$/;

function normalLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/** `[label]: ` then the http(s) autolink main draws for the address (its words are its address), then an optional title. */
function definition(line: InlineNode[]): Omit<Definition, "blockIndex" | "lineIndex"> | null {
  const [head, link, tail, ...rest] = line;
  if (rest.length > 0 || head?.type !== "text" || link?.type !== "link" || link.title !== undefined || !/^https?:\/\//i.test(link.href)) return null;
  const label = DEFINITION_START.exec(head.value)?.[1];
  const [words, ...more] = link.children;
  if (label === undefined || more.length > 0 || words?.type !== "text" || (link.href !== words.value && link.href !== `https://${words.value}`)) return null;
  if (tail === undefined || (tail.type === "text" && tail.value.trim() === "")) return { label, href: link.href };
  const title = tail.type === "text" ? TITLE.exec(tail.value) : null;
  if (title === null) return null;
  const value = title[1] ?? title[2] ?? title[3] ?? "";
  return value === "" ? { label, href: link.href } : { label, href: link.href, title: value };
}

function plain(node: InlineNode): boolean {
  switch (node.type) {
    case "text": case "code": case "math": return !/[[\]]/.test(node.value);
    case "strong": case "em": case "del": return node.children.every(plain);
    case "link": case "file": case "image": return false;
  }
}

/** Every line of text the blocks draw; a code or math block as one line of code, read for definition-shaped text only. */
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
      case "code": case "math": yield [{ type: "code", value: block.value }]; break;
      case "visualization": case "hr": break;
    }
  }
}

/** A line's text as drawn (a code span's and a formula's source included), and where each node starts in it. */
function drawn(line: InlineNode[]): { text: string; offsets: Map<InlineNode, number> } {
  let text = "";
  const offsets = new Map<InlineNode, number>();
  const walk = (nodes: InlineNode[]): void => {
    for (const node of nodes) {
      offsets.set(node, text.length);
      switch (node.type) {
        case "text": case "code": case "math": text += node.value; break;
        case "strong": case "em": case "del": walk(node.children); break;
        case "link": case "file": text += shownText(node.children) ?? "\ufffc"; break;
        case "image": text += "\ufffc"; break;
      }
    }
  };
  walk(line);
  return { text, offsets };
}

function swapBlocks(blocks: MarkdownBlock[], resolved: Map<InlineNode[], InlineNode[]>): MarkdownBlock[] {
  const line = (nodes: InlineNode[]): InlineNode[] => resolved.get(nodes) ?? nodes;
  return blocks.map((block): MarkdownBlock => {
    switch (block.type) {
      case "heading": return { ...block, content: line(block.content) };
      case "paragraph": return { ...block, lines: block.lines.map(line) };
      case "list": return { ...block, items: block.items.map((item) => ({ ...item, content: line(item.content), ...(item.blocks === undefined ? {} : { blocks: swapBlocks(item.blocks, resolved) }) })) };
      case "blockquote": return { ...block, blocks: swapBlocks(block.blocks, resolved) };
      case "table": return { ...block, header: block.header.map(line), rows: block.rows.map((row) => row.map(line)) };
      case "visualization": case "math": case "code": case "hr": return block;
    }
  });
}
