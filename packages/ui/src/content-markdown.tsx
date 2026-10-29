import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { markdownMediaId, safeMarkdownLink, remarkContentHeadings } from "@zzsh/content/markdown/policy";
import { ContentImage } from "./content-document";

const schema = {
  ...defaultSchema,
  // Heading IDs are generated in our content- namespace; author HTML and IDs are never imported.
  clobberPrefix: "",
  protocols: { ...defaultSchema.protocols, src: ["media"], href: ["https"] },
};

export function MarkdownDocument({ markdown, mediaUrls = {}, compact = false }: {
  markdown: string;
  mediaUrls?: Readonly<Record<string, string | null>>;
  compact?: boolean;
}) {
  const components: Components = {
    table: ({ children, node: _node, ...props }) => <div className="content-markdown-table" role="region" tabIndex={0} aria-label="说明表格，可横向滚动"><table {...props}>{children}</table></div>,
    img: ({ src, alt }) => {
      const id = markdownMediaId(src);
      return <ContentImage inline src={id ? mediaUrls[id] : null} alt={alt || "正文图片"} />;
    },
    a: ({ href, children }) => {
      const safe = safeMarkdownLink(href);
      if (!safe) return <span>{children}</span>;
      return <a href={safe} {...(safe.startsWith("https:") ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{children}</a>;
    },
  };
  return <div className={`content-markdown typeset typeset-docs${compact ? " content-markdown--compact" : ""}`}>
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkContentHeadings]} rehypePlugins={[[rehypeSanitize, schema]]}
      components={components} urlTransform={(url, key) => key === "src" ? markdownMediaId(url) ? url : "" : safeMarkdownLink(url) ?? ""}>
      {markdown}
    </ReactMarkdown>
  </div>;
}
