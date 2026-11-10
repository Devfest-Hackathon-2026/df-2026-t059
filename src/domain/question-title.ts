import { THREAD_TITLE_MAX_LENGTH } from "./limits.ts";

/** タイトルではブロック数式も行内で表示する。数式の区切りを保ったまま扱う。 */
export function titleParts(text: string) {
  const parts: { text: string; latex?: string; start?: number }[] = [];
  let offset = 0;
  for (const match of text.matchAll(/(?<!\\)(?:\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\])/gu)) {
    if (match.index > offset) parts.push({ text: text.slice(offset, match.index) });
    parts.push({ text: match[0], latex: match[1] ?? match[2] ?? match[3] ?? match[4], start: match.index });
    offset = match.index + match[0].length;
  }
  if (offset < text.length) parts.push({ text: text.slice(offset) });
  return parts;
}

export function makeTitle(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (Array.from(normalized).length <= maxLength) return normalized;
  let remaining = maxLength - 1;
  let title = "";
  for (const part of titleParts(normalized)) {
    const chars = Array.from(part.text);
    if (chars.length > remaining) {
      if (part.latex === undefined) title += chars.slice(0, remaining).join("");
      break;
    }
    title += part.text;
    remaining -= chars.length;
  }
  return !title && maxLength >= 5 ? "数式の質問" : `${title.trimEnd()}…`;
}


const sampleMaterial = /^([^\s、。！？$]{1,16}?)(?:と不純物からなる|を含む)試料/u;

export function isQuestionExcerpt(title: string) {
  const length = Array.from(title).length;
  return title.endsWith("…") || length > THREAD_TITLE_MAX_LENGTH || (length >= 32 && sampleMaterial.test(title));
}

/** AIが長い問題文の書き出しをそのまま返した場合は題名として保存しない。 */
export function generatedQuestionTitle(title: string | undefined, original: string) {
  const candidate = title?.replace(/\s+/gu, " ").trim();
  if (!candidate || isQuestionExcerpt(candidate)) return undefined;
  const chars = Array.from(candidate);
  if (chars.length >= 32 && original.startsWith(chars.slice(0, Math.ceil(chars.length * 0.75)).join(""))) return undefined;
  return candidate;
}

/** 旧データの抜粋を、本文を開く前に見分けられる短い題名にする。 */
export function questionHeading(title: string) {
  const text = title.trim();
  if (!isQuestionExcerpt(text)) return text || "授業の質問";

  const material = sampleMaterial.exec(text)?.[1];
  if (material) return `試料中の${material}の定量`;

  const topic = /^([^、。！？$]{2,20}?)(?:について|に関する)/u.exec(text)?.[1];
  if (topic) return `${topic}の質問`;

  const formula = titleParts(text).find((part) => part.latex && Array.from(part.text).length <= 35);
  if (formula) return `${formula.text} の質問`;

  const firstSentence = /^([^。！？]{2,28})[。！？]/u.exec(text)?.[1];
  return firstSentence || "授業の質問";
}
