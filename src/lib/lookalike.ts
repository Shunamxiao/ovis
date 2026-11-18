import { CASE_FOLDING_DATA } from "./caseFolding.generated.ts";
import { CONFUSABLES_DATA } from "./confusables.generated.ts";

const caseFolds = new Map(CASE_FOLDING_DATA.split(";").map((entry) => {
  const [from, to] = entry.split("=") as [string, string];
  return [String.fromCodePoint(parseInt(from, 16)), String.fromCodePoint(...to.split(" ").map((hex) => parseInt(hex, 16)))];
}));
/** Unicode's full case folding (CaseFolding.txt C and F): `Straße`, `STRASSE` and `STRAẞE` all fold to `strasse` */
const toCasefold = (text: string): string => Array.from(text, (char) => caseFolds.get(char) ?? char).join("");

const confusables = new Map(CONFUSABLES_DATA.split(";").map((entry) => {
  const [from, to] = entry.split("=") as [string, string];
  return [String.fromCodePoint(parseInt(from, 16)), String.fromCodePoint(parseInt(to, 16))];
}));
/** Each letter Unicode draws like an ASCII letter or digit (confusables.txt, UTS #39) as that one: Cyrillic `о` and Greek `ο` as `o`, `1` as `l` */
const unconfused = (text: string): string => Array.from(text, (char) => confusables.get(char) ?? char).join("");

/**
 * What a name reads as, for telling rows apart (#2220): Unicode's compatibility caseless form (Unicode 3.13,
 * D146: NFKD(toCasefold(NFKD(toCasefold(NFD(x)))))), then its letters, marks and digits alone. Marks a page
 * does not draw, spacing, punctuation, blanks such as U+2800 and controls such as U+007F all go; the last
 * NFD puts the marks left in canonical order again, so a skeleton is its own skeleton. Then a letter drawn
 * like a Latin one is that Latin letter (unconfused), folded again (#2233): only after the case folding, so a
 * capital `I` stays `i` and every name keeps the skeleton of its other case. Two rows with one skeleton may
 * look the same, so a typed name picks neither (their numbers and a click still do). That over-refuses pairs
 * like `production.` and `production`.
 */
export const skeleton = (text: string): string => toCasefold(unconfused(toCasefold(toCasefold(text.normalize("NFD")).normalize("NFKD")).normalize("NFKD"))).normalize("NFKD")
  .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "").replace(/[^\p{L}\p{M}\p{N}]/gu, "").normalize("NFD");
