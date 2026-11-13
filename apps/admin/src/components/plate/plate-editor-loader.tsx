import { Component, forwardRef, lazy, useRef, type ReactNode } from "react";
import type { PlateDocumentEnvelope } from "@zzsh/content/plate";
import { PlateDocument } from "@zzsh/ui/plate-document";
import { Button } from "../ui/button";
import { StatusMessage } from "../ui-elements";
import type { PlateEditorHandle, PlateEditorProps } from "./plate-editor";

const LazyEditor = lazy(() => import("./plate-editor"));

class EditorBoundary extends Component<{ children: ReactNode; fallback: () => ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback() : this.props.children; }
}

const PlateEditorLoader = forwardRef<PlateEditorHandle, PlateEditorProps>(function PlateEditorLoader(props, ref) {
  const latest = useRef<PlateDocumentEnvelope>({ format: "plate", schemaVersion: 1, preset: props.preset, value: props.value });
  return <EditorBoundary fallback={() => <div className="space-y-3">
    <StatusMessage error="编辑器暂时无法加载，正文已切换为只读。" />
    <p className="text-sm text-muted-foreground">刷新页面后重试。未保存的修改可能丢失，请先复制需要保留的内容。</p>
    <Button type="button" size="sm" variant="secondary" onClick={() => window.location.reload()}>刷新页面</Button>
    <article aria-label="正文只读视图"><PlateDocument document={latest.current} mediaUrls={props.mediaUrls} imageUrls={props.imageUrls} /></article>
  </div>}>
    <LazyEditor {...props} ref={ref} onChange={document => { latest.current = document; props.onChange(document); }} />
  </EditorBoundary>;
});

export default PlateEditorLoader;
