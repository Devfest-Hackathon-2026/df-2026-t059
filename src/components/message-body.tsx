import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import styles from "./message-body.module.css";

const components: Components = {
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h3>{children}</h3>,
  h3: ({ children }) => <h4>{children}</h4>,
  a: ({ href, title, children }) => href
    ? <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>
    : <span>{children}</span>,
  img: ({ alt }) => <span className={styles.imageAlt}>{alt || "画像"}</span>,
  table: ({ children }) => <div className={styles.tableScroll}><table>{children}</table></div>,
};

/** 文字列の保存形式を変えず、本文だけにMarkdownと数式の表示を適用する。 */
export const MessageBody = memo(function MessageBody({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`${styles.body}${className ? ` ${className}` : ""}`}>
      <Markdown components={components} remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { trust: false, strict: "ignore", maxSize: 10 }]]}>
        {text}
      </Markdown>
    </div>
  );
});
