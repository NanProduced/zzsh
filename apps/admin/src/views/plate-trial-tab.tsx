import { lazy, Suspense, useEffect, useState } from "react";
import { extractPlate, plateDigest, validatePlateDocument, PRESETS, type PlateDocumentEnvelope, type PlatePreset } from "@zzsh/content/plate";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";

const PlateEditor = lazy(() => import("../components/plate/plate-editor"));

const empty = (preset: PlatePreset): PlateDocumentEnvelope => ({ format: "plate", schemaVersion: 1, preset, value: [{ type: "p", children: [{ text: "" }] }] });

export function PlateTrialTab() {
  const [preset, setPreset] = useState<PlatePreset>("help");
  const [doc, setDoc] = useState<PlateDocumentEnvelope>(empty("help"));
  const [digest, setDigest] = useState("");
  const check = validatePlateDocument(doc, { preset, mode: "draft" });
  const projection = extractPlate(doc);
  useEffect(() => {
    let alive = true;
    void plateDigest(doc).then((hex) => { if (alive) setDigest(hex); });
    return () => { alive = false; };
  }, [doc]);
  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={preset} items={PRESETS.map((p) => ({ value: p, label: p }))} onValueChange={(value) => { if (value === null) return; const next = value as PlatePreset; setPreset(next); setDoc(empty(next)); }}>
          <SelectTrigger className="w-40" aria-label="预设"><SelectValue /></SelectTrigger>
          <SelectContent>
            {PRESETS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground" role="status">
          {check.ok ? "校验通过" : `校验失败 ${check.errors.length} 项`}
          {" · "}正文 {projection.plainText.length} 字 / {new TextEncoder().encode(projection.plainText).length} 字节
          {" · "}媒体 {projection.mediaIds.length + projection.imageIds.length}
        </span>
      </div>
      {!check.ok && (
        <ul className="space-y-1 rounded-md border border-destructive/40 p-3 text-sm text-destructive">
          {check.errors.slice(0, 12).map((e, i) => <li key={`${e.path}-${i}`}><code>{e.path}</code> {e.code} {e.message}</li>)}
        </ul>
      )}
      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <PlateEditor key={preset} preset={preset} value={doc.value} onChange={setDoc} />
      </Suspense>
      <p className="break-all font-mono text-xs text-muted-foreground">digest {digest}</p>
    </div>
  );
}