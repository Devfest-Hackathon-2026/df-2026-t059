import katex from "katex";
import { memo } from "react";
import { titleParts } from "../domain/question-title";
import "katex/dist/katex.min.css";

export const MathTitle = memo(function MathTitle({ text }: { text: string }) {
  return titleParts(text).map((part) => {
    if (!part.latex) return part.text;
    const html = katex.renderToString(part.latex, { trust: false, throwOnError: false, strict: "ignore", maxSize: 10, maxExpand: 500 });
    // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX の出力だけを描画する（trust: false）。
    return <span className="title-math" key={part.start} dangerouslySetInnerHTML={{ __html: html }} />;
  });
});
