import { type InlineNode, type MarkdownBlock } from "../../shared/markdown.ts";
import { skeleton } from "./lookalike.ts";

/**
 * Reference-style links (`[text][label]`, `[label][]`, `[label]` with `[label]: https://… "title"`)
 * in a file's Preview (#3987, #4002). Read over the blocks as they are drawn, once the whole
 * document's structure is final, never on text still arriving (chat does not read them).
 *
 * - A definition is a line a top-level paragraph starts with, drawn as `[label]: `, the http(s)
 *   autolink that line already shows, and an optional quoted title. The reference goes where that
 *   link went.
 * - A label is read only when its definition is the one place in everything drawn (code, formulas
 *   and a picture's words included) where it is written in brackets and followed by anything but a
 *   word, the end of the line or plain punctuation with no address after it. Labels are compared by
 *   how they look (every bracket, space, accent and invisible character, and letters drawn like
 *   Latin ones, folded), so a second definition, a look-alike one, or definition-shaped text in a
 *   cell, heading, list item, quote or mid-sentence leaves every use of the label as text, and
 *   links nothing itself.
 * - A definition's line is left out only when a visible link was drawn from that exact line; a
 *   definition nothing uses stays as written, so no text an agent wrote vanishes.
 * - A comment holding a bracketed label turns it all off (a definition may be meant inside it, and
 *   the blocks no longer show where it was), and so does a character that reorders what is drawn
 *   (bidi controls).
 */
export function readReferenceLinks(blocks: MarkdownBlock[], source: string): MarkdownBlock[] {
  if (BIDI.test(source) || [...source.matchAll(COMMENT)].some(([comment]) => /\[[^[\]\n]+\]/.test(folded(comment)))) return blocks;
  const lines = [...runs(blocks)];
  const seen = lines.map((line) => drawn(line, true).text);
  if (seen.some((text) => BIDI.test(text))) return blocks;

  const written = new Map<string, number>();
  for (const text of seen) {
    const looks = folded(text);
    for (const match of looks.matchAll(BRACKETED)) {
      if (!definitionShaped(looks.slice(match.index + match[0].length))) continue;
      for (const label of [match[1], match[2]]) {
        if (label) written.set(labelKey(label), (written.get(labelKey(label)) ?? 0) + 1);
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
      const key = labelKey(folded(read.label));
      if (key !== "" && written.get(key) === 1) definitions.set(normalLabel(read.label), { ...read, blockIndex, lineIndex });
    }
  });
  if (definitions.size === 0) return blocks;

  const drawnLines = lines.map((line) => drawn(line));
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
    const across = (nodes: InlineNode[], k: number, value: string, open: number, at: number): { link: InlineNode; closer: number; rest: string; restAt: number } | null => {
      if (!opens(at + open)) return null;
      let j = k + 1;
      while (j < nodes.length && plain(nodes[j]!)) j += 1;
      const closer = nodes[j];
      if (j === k + 1 || closer?.type !== "text") return null;
      const close = closer.value.indexOf("]");
      const match = close === -1 || closer.value.lastIndexOf("[", close) !== -1 ? null : CLOSES_ACROSS.exec(closer.value.slice(close));
      const target = match === null ? undefined : definitions.get(normalLabel(match[1]!));
      const words = value.slice(open + 1);
      const children: InlineNode[] = [...(words === "" ? [] : [{ type: "text" as const, value: words }]), ...nodes.slice(k + 1, j), ...(close === 0 ? [] : [{ type: "text" as const, value: closer.value.slice(0, close) }])];
      if (match === null || target === undefined || !visible(children)) return null;
      resolvedEnd = offsets.get(closer)! + close + match[0].length;
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
            if (target === undefined || !visible([{ type: "text", value: match[1]! }])) continue;
            push({ type: "text", value: value.slice(offset, match.index) });
            push(linkTo(target, [{ type: "text", value: match[1]! }]));
            resolvedEnd = end;
            offset = match.index + match[0].length;
          }
          const open = value.lastIndexOf("[");
          const crossed = open >= offset && !value.includes("]", open) ? across(nodes, k, value, open, at) : null;
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
const BRACKETED = /\[([^[\]\n]+)\](?:\[([^[\]\n]*)\])?/g;
const BIDI = /\p{Bidi_Control}/u;
// as the HTML reader takes one: to its `-->`, or to the end of the file
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const DEFINITION_START = new RegExp(String.raw`^ {0,3}${LABEL}:[ \t]+$`);
const TITLE = /^[ \t]+(?:"([^"\n]*)"|'([^'\n]*)'|\(([^()\n]*)\))[ \t]*$/;

function normalLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/** A folded label, with the letter pairs Unicode draws like one letter (`rn` and `m`) folded too. */
function labelKey(label: string): string {
  return label.trim().replace(/ +/g, " ").replace(/rn/g, "m").replace(/vv/g, "w").replace(/cl/g, "d");
}

const folds = new Map<string, string>();
function foldChar(char: string): string {
  if (/[\p{L}\p{N}]/u.test(char)) return skeleton(char).replace(/\p{M}/gu, "");
  if (/[\p{M}\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(char)) return "";
  if (/\s/u.test(char)) return " ";
  if (/\p{Ps}/u.test(char)) return "[";
  if (/\p{Pe}/u.test(char)) return "]";
  return char.normalize("NFKC");
}
/** Text as it looks: every bracket as `[` or `]`, every space as one, invisible characters and accents gone, letters as their skeleton. */
function folded(text: string): string {
  let out = "";
  for (const char of text) {
    let fold = folds.get(char);
    if (fold === undefined) { fold = foldChar(char); folds.set(char, fold); }
    out += fold;
  }
  return out;
}

/** After a bracketed label, folded: anything but a word, the line's end or plain punctuation with no address after it may read as a definition. */
function definitionShaped(rest: string): boolean {
  const next = /\S/u.exec(rest)?.[0];
  if (next === undefined || /[a-z0-9\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(next)) return false;
  return !".,;!?'\"[]-–—&".includes(next) || /^[^\p{L}\p{N}]*(?:[a-z][a-z0-9+.-]*:|www\.|[a-z0-9-]+(?:\.[a-z0-9-]+)+)/u.test(rest);
}

function visible(nodes: InlineNode[]): boolean {
  return folded(drawn(nodes, true).text).trim() !== "";
}

/** `[label]: ` then the http(s) autolink main draws for the address (its words are its address), then an optional title. */
function definition(line: InlineNode[]): Omit<Definition, "blockIndex" | "lineIndex"> | null {
  const [head, link, tail, ...rest] = line;
  if (rest.length > 0 || head?.type !== "text" || link?.type !== "link" || link.title !== undefined || !/^https?:\/\//i.test(link.href)) return null;
  const label = DEFINITION_START.exec(head.value)?.[1];
  const [words, ...more] = link.children;
  if (label === undefined || more.length > 0 || words?.type !== "text" || (link.href !== words.value && !(/^www\./i.test(words.value) && link.href === `https://${words.value}`))) return null;
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

/**
 * A line's text as drawn, and where each node starts in it: a code span's and a link's words, a
 * picture's words (drawn when it fails to load), a formula's source. `count` reads it as it shows:
 * character references in code (an SVG or a diagram draws them) and a formula's commands, as
 * KaTeX draws `\text{[}` or `\lbrack`.
 */
function drawn(line: InlineNode[], count = false): { text: string; offsets: Map<InlineNode, number> } {
  let text = "";
  const offsets = new Map<InlineNode, number>();
  const walk = (nodes: InlineNode[]): void => {
    for (const node of nodes) {
      offsets.set(node, text.length);
      switch (node.type) {
        case "text": text += node.value; break;
        case "code": text += count ? characters(node.value) : node.value; break;
        case "math": text += count ? formula(node.value) : node.value; break;
        case "strong": case "em": case "del": case "link": case "file": walk(node.children); break;
        case "image": text += node.alt; break;
      }
    }
  };
  walk(line);
  return { text, offsets };
}

function characters(value: string): string {
  return value.replace(/&#x([0-9a-f]{1,6});?|&#(\d{1,7});?|&(lsqb|lbrack|rsqb|rbrack|colon);/gi, (whole, hex: string | undefined, decimal: string | undefined, name: string | undefined) => {
    if (name !== undefined) return /^(?:lsqb|lbrack)$/i.test(name) ? "[" : /^(?:rsqb|rbrack)$/i.test(name) ? "]" : ":";
    const point = hex !== undefined ? Number.parseInt(hex, 16) : Number(decimal);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : whole;
  });
}

function formula(value: string): string {
  return characters(value).replace(/\\(?:lbrack|lsqb)(?![a-zA-Z])/g, "[").replace(/\\(?:rbrack|rsqb)(?![a-zA-Z])/g, "]").replace(/\\colon(?![a-zA-Z])/g, ":")
    .replace(/\\[a-zA-Z]+\*?/g, "").replace(/\\(.)/g, "$1").replace(/[{}]/g, "");
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
