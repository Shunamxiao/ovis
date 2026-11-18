import { parseInline, shownText, type InlineNode, type MarkdownBlock } from "../../shared/markdown.ts";

/**
 * Reference-style links (`[text][label]`, `[label][]`, `[label]` with `[label]: https://… "title"`)
 * in a file's Preview (#3987, #4002), read over the blocks once the document's structure is final,
 * never on text still arriving (chat does not read them).
 *
 * A reference draws as the inline link `[text](address "title")` would: the link is made by the
 * inline reader itself, so it takes the same addresses and the same safety rules. Unlike GitHub,
 * no definition line is left out: every address a reference can go to stays on screen, as written
 * (#4002: no text an agent wrote vanishes, no link goes where the reader cannot see).
 *
 * - A definition is a line a top-level paragraph starts with, drawn as `[label]: address` with an
 *   optional quoted title, whose address the inline reader links as a web address.
 * - A label defined twice (in case and spacing), with or without a web address, defines nothing.
 * - Read as written, as before: a footnote (`[^1]`), a reference after `!`, `\\`, `[` or a stray `]`
 *   (an image reference, a linked badge), a shortcut before `(`, `[` or `]`, and one followed by a
 *   colon (text shaped as a definition, which links nothing).
 */
export function readReferenceLinks(blocks: MarkdownBlock[]): MarkdownBlock[] {
  // every line shaped as a definition counts, read or not: a label written so twice defines nothing
  const read = new Map<string, { link: LinkNode | null; twice: boolean }>();
  const definitionLines = new Set<InlineNode[]>();
  for (const block of blocks) {
    if (block.type !== "paragraph") continue;
    for (const line of block.lines) {
      const found = definition(line);
      if (found === null) break;
      definitionLines.add(line);
      const known = read.get(found.label);
      read.set(found.label, known === undefined ? { link: found.link, twice: false } : { ...known, twice: true });
    }
  }
  const definitions = new Map([...read].flatMap(([label, { link, twice }]) => link !== null && !twice ? [[label, link] as const] : []));
  if (definitions.size === 0) return blocks;

  const resolved = new Map<InlineNode[], InlineNode[]>();
  for (const line of runs(blocks)) {
    // a definition's own line is drawn as written, so the address a reference goes to stays on it
    if (definitionLines.has(line)) continue;
    const drawn = resolveLine(line, definitions);
    if (drawn !== null) resolved.set(line, drawn);
  }
  return resolved.size === 0 ? blocks : swapBlocks(blocks, resolved);
}

type LinkNode = Extract<InlineNode, { type: "link" }>;

// at most 999 characters, as CommonMark: a longer run is no label, and the search stays linear on a line
// with a `[` that never closes
const LABEL = String.raw`\[(?!\^)([^[\]\n]{1,999})\]`;
// a shortcut's words are its label: past 999 characters it names no definition
const REFERENCE = new RegExp(String.raw`\[(?!\^)([^[\]\n]+)\](?:\[([^[\]\n]{0,999})\])?`, "gu");
const COLON = /[ \t]*:/y;
const CLOSES_ACROSS = new RegExp(String.raw`^\]${LABEL.slice(0, -2)}\]`, "u");
const SHAPED = new RegExp(String.raw`^ {0,3}${LABEL}:`, "u");
const DEFINITION = new RegExp(String.raw`^ {0,3}${LABEL}:[ \t]+(?:<([^\s<>[\]]+)>|([^\s<>[\]]+))((?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?)[ \t]*$`, "u");

function normalLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * A line shaped as a definition (`[label]:` first): its label, and the link the inline reader makes
 * of its address, or null when it has no web address, or holds markup, a bracket or anything but
 * an address and a title (read only as written).
 */
function definition(line: InlineNode[]): { label: string; link: LinkNode | null } | null {
  // shaped as written: a line whose `[label]:` is in emphasis or code is no definition
  const [first] = line;
  const shaped = first?.type === "text" ? SHAPED.exec(first.value) : null;
  const label = shaped === null ? "" : normalLabel(shaped[1]!);
  if (label === "") return null;
  const match = line.every((node) => node.type === "text" || autolink(node)) ? DEFINITION.exec(shownText(line) ?? "") : null;
  const [made, ...more] = match === null ? [] : parseInline(`[x](${match[2] ?? match[3]}${match[4]})`);
  return { label, link: more.length === 0 && made?.type === "link" ? made : null };
}


/** A link whose words are its own address (`https://x.dev`, `www.x.dev`), as the inline reader draws one. */
function autolink(node: InlineNode): boolean {
  if (node.type !== "link" || node.title !== undefined) return false;
  const [words, ...more] = node.children;
  return more.length === 0 && words?.type === "text" && (node.href === words.value || node.href === `https://${words.value}`);
}

function linkTo(target: LinkNode, children: InlineNode[]): InlineNode {
  return { ...target, children };
}

/** The line with its references drawn as links, or null when it holds none. */
function resolveLine(line: InlineNode[], definitions: ReadonlyMap<string, LinkNode>): InlineNode[] | null {
  let text = "";
  const offsets = new Map<InlineNode, number>();
  const walk = (nodes: InlineNode[]): void => {
    for (const node of nodes) {
      offsets.set(node, text.length);
      switch (node.type) {
        case "text": case "code": case "math": text += node.value; break;
        case "strong": case "em": case "del": case "link": case "file": walk(node.children); break;
        case "image": text += node.alt; break;
      }
    }
  };
  walk(line);
  let changed = false;
  let resolvedEnd = -1;
  const opens = (start: number): boolean => {
    const before = text[start - 1];
    return !(before === "!" || before === "\\" || before === "[" || (before === "]" && start !== resolvedEnd));
  };
  const closes = (end: number, shortcut: boolean): boolean => {
    const after = text[end];
    COLON.lastIndex = end;
    return !(COLON.test(text) || (shortcut && (after === "(" || after === "[" || after === "]")));
  };
  /** `[` + emphasis, code or a formula with no bracket inside + `][label]` at the start of the next text holding a `]`. */
  const across = (nodes: InlineNode[], k: number, value: string, open: number, at: number): { link: InlineNode; closer: number; rest: string; restAt: number } | null => {
    if (!opens(at + open)) return null;
    let j = k + 1;
    while (j < nodes.length && plain(nodes[j]!)) j += 1;
    const closer = nodes[j];
    if (j === k + 1 || closer?.type !== "text") return null;
    const close = closer.value.indexOf("]");
    const match = close === -1 || closer.value.lastIndexOf("[", close) !== -1 ? null : CLOSES_ACROSS.exec(closer.value.slice(close));
    const target = match === null ? undefined : definitions.get(normalLabel(match[1]!));
    const end = offsets.get(closer)! + close + (match?.[0].length ?? 0);
    const opening = value.slice(open + 1);
    if (match === null || target === undefined || opening.startsWith("^") || !closes(end, false)) return null;
    resolvedEnd = end;
    const children: InlineNode[] = [...(opening === "" ? [] : [{ type: "text" as const, value: opening }]), ...nodes.slice(k + 1, j), ...(close === 0 ? [] : [{ type: "text" as const, value: closer.value.slice(0, close) }])];
    return { link: linkTo(target, children), closer: j, rest: closer.value.slice(close + match[0].length), restAt: end };
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
          const label = match[2] || match[1]!;
          const target = definitions.get(normalLabel(label));
          if (target === undefined || match[1]!.trim() === "" || [...label].length > 999 || !opens(start) || !closes(end, match[2] === undefined)) continue;
          push({ type: "text", value: value.slice(offset, match.index) });
          push(linkTo(target, [{ type: "text", value: match[1]! }]));
          changed = true;
          resolvedEnd = end;
          offset = match.index + match[0].length;
        }
        const open = value.lastIndexOf("[");
        const crossed = open >= offset && !value.includes("]", open) ? across(nodes, k, value, open, at) : null;
        if (crossed === null) { push({ type: "text", value: value.slice(offset) }); break; }
        push({ type: "text", value: value.slice(offset, open) });
        push(crossed.link);
        changed = true;
        k = crossed.closer;
        value = crossed.rest;
        at = crossed.restAt;
      }
    }
    return out;
  };
  const out = resolve(line);
  return changed ? out : null;
}

function plain(node: InlineNode): boolean {
  switch (node.type) {
    case "text": case "code": case "math": return !/[[\]]/.test(node.value);
    case "strong": case "em": case "del": return node.children.every(plain);
    case "link": case "file": case "image": return false;
  }
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

function swapBlocks(blocks: MarkdownBlock[], resolved: ReadonlyMap<InlineNode[], InlineNode[]>): MarkdownBlock[] {
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
