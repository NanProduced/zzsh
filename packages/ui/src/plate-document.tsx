import type { CSSProperties, ReactElement, ReactNode } from "react";
import { extractPlate, type PlateDocumentEnvelope, type PlateNode } from "@zzsh/content/plate";

const COLOR_TOKENS = new Set(["red", "orange", "green", "blue", "gray"]);

type Props = {
  document: PlateDocumentEnvelope;
  mediaUrls?: Record<string, string>;
  imageUrls?: Record<string, string>;
  anchorPrefix?: string;
  showTableOfContents?: boolean;
};

function marksStyle(node: PlateNode): CSSProperties | undefined {
  const style: CSSProperties = {};
  let any = false;
  for (const key of ["color", "backgroundColor"] as const) {
    const token = node[key];
    if (typeof token === "string" && COLOR_TOKENS.has(token)) {
      style[key === "color" ? "color" : "backgroundColor"] = key === "color"
        ? `var(--plate-${token})` : `var(--plate-highlight-${token}, var(--plate-${token}))`;
      any = true;
    }
  }
  return any ? style : undefined;
}

function Leaf({ node }: { node: PlateNode }): ReactElement {
  const style = marksStyle(node);
  let out: ReactNode = node.text ?? "";
  if (node.code) out = <code>{out}</code>;
  if (node.bold) out = <strong>{out}</strong>;
  if (node.italic) out = <em>{out}</em>;
  if (node.underline) out = <u>{out}</u>;
  if (node.strikethrough) out = <s>{out}</s>;
  const commented = Object.keys(node).some((k) => k.startsWith("comment_"));
  if (commented) out = <mark className="plate-comment">{out}</mark>;
  return style ? <span style={style}>{out}</span> : <>{out}</>;
}

function inline(nodes: PlateNode[] | undefined, keyBase: string): ReactNode[] {
  return (nodes ?? []).map((child, i) => {
    const key = `${keyBase}-${i}`;
    if (typeof child.text === "string") return <Leaf key={key} node={child} />;
    if (child.type === "a") {
      const url = typeof child.url === "string" ? child.url : "";
      const external = url.startsWith("https://");
      return (
        <a key={key} href={url} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
          {inline(child.children, key)}
        </a>
      );
    }
    return <span key={key}>{plain(child)}</span>;
  });
}

function plain(node: PlateNode): string {
  if (typeof node.text === "string") return node.text;
  if (node.type === "img") return typeof node.alt === "string" ? node.alt : "";
  return (node.children ?? []).map(plain).join(node.type === "tr" ? "\t" : "");
}

function Block({ node, id, urls, anchorPrefix }: { node: PlateNode; id: string; urls: Record<string, string>; anchorPrefix: string }): ReactElement | null {
  const kids = node.children ?? [];
  const anchor = typeof node.id === "string" ? `${anchorPrefix}${node.id}` : undefined;
  switch (node.type) {
    case "p":
    case "h2":
    case "h3":
    case "h4": {
      const Tag = node.type as "p" | "h2" | "h3" | "h4";
      const listType = node.listStyleType;
      const content = inline(kids, id);
      if (listType === "todo") {
        return (
          <li className="plate-todo" data-checked={node.checked === true}>
            <input type="checkbox" checked={node.checked === true} readOnly tabIndex={-1} aria-hidden="true" />
            {content}
          </li>
        );
      }
      if (listType === "disc" || listType === "decimal") {
        const value = listType === "decimal" && typeof node.listStart === "number" && Number.isSafeInteger(node.listStart) && node.listStart > 0 ? node.listStart : undefined;
        return <li data-indent={node.indent ?? 1} value={value}>{content}</li>;
      }
      return <Tag id={anchor}>{content}</Tag>;
    }
    case "blockquote":
      return <blockquote>{blocks(kids, id, urls, anchorPrefix)}</blockquote>;
    case "hr":
      return <hr />;
    case "img": {
      const key = typeof node.imageId === "string" ? node.imageId : typeof node.mediaId === "string" ? node.mediaId : "";
      const src = urls[key];
      const alt = typeof node.alt === "string" ? node.alt : "";
      const image = src ? <img src={src} alt={alt} loading="lazy" /> : <span className="plate-image-missing">{alt || "图片不可用"}</span>;
      return typeof node.caption === "string" && node.caption ? (
        <figure className="plate-image-figure">{image}<figcaption className="plate-image-caption">{node.caption}</figcaption></figure>
      ) : image;
    }
    case "code_block":
      return (
        <pre>
          <code>{kids.map((c, i) => <span key={`${id}-${i}`} className="plate-code-line">{plain(c)}{"\n"}</span>)}</code>
        </pre>
      );
    case "callout":
      return (
        <div className="plate-callout" data-variant={node.variant === "warning" ? "warning" : "info"} role="note">
          {blocks(kids, id, urls, anchorPrefix)}
        </div>
      );
    case "toggle":
      return (
        <details className="plate-toggle">
          <summary>{kids[0] ? plain(kids[0]) : "展开"}</summary>
          {blocks(kids.slice(1), id, urls, anchorPrefix)}
        </details>
      );
    case "table":
      return (
        <div className="plate-table-scroll" role="region" tabIndex={0} aria-label="表格">
          <table>
            <tbody>{blocks(kids, id, urls, anchorPrefix)}</tbody>
          </table>
        </div>
      );
    case "tr":
      return <tr>{blocks(kids, id, urls, anchorPrefix)}</tr>;
    case "td":
    case "th": {
      const Tag = node.type as "td" | "th";
      return <Tag>{blocks(kids, id, urls, anchorPrefix)}</Tag>;
    }
    case "toc":
      return null;
    default:
      return <p>{plain(node)}</p>;
  }
}

function blocks(nodes: PlateNode[], keyBase: string, urls: Record<string, string>, anchorPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let list: { type: "disc" | "decimal" | "todo"; items: ReactNode[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.type === "decimal" ? "ol" : "ul";
    out.push(<Tag key={`${keyBase}-list-${out.length}`} className={list.type === "todo" ? "plate-todo-list" : undefined}>{list.items}</Tag>);
    list = null;
  };
  (nodes ?? []).forEach((node, i) => {
    const id = `${keyBase}-${i}`;
    const lt = node.listStyleType;
    if (lt === "disc" || lt === "decimal" || lt === "todo") {
      if (!list || list.type !== lt) flush();
      list = list ?? { type: lt, items: [] };
      list.items.push(<Block key={id} node={node} id={id} urls={urls} anchorPrefix={anchorPrefix} />);
      return;
    }
    flush();
    out.push(<Block key={id} node={node} id={id} urls={urls} anchorPrefix={anchorPrefix} />);
  });
  flush();
  return out;
}

export function PlateDocument({ document, mediaUrls, imageUrls, anchorPrefix = "content-", showTableOfContents = true }: Props): ReactElement {
  const urls = { ...mediaUrls, ...imageUrls };
  const toc = showTableOfContents ? extractPlate(document).toc : [];
  return (
    <div className="plate-document">
      {toc.length > 0 && (
        <nav className="plate-toc" aria-label="目录">
          <ul>
            {toc.map((t) => (
              <li key={t.id} data-level={t.level}>
                <a href={`#${anchorPrefix}${t.id.replace(/^content-/, "")}`}>{t.text}</a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {blocks(document.value ?? [], "b", urls, anchorPrefix)}
    </div>
  );
}
