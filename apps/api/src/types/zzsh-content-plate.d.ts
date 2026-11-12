// Ambient declaration so the CommonJS/Node-resolution API can consume the P0
// shared Plate contract published as @zzsh/content/plate (ESM .mjs + .d.mts).
// The package "exports" types are not visible under moduleResolution "Node";
// runtime require() resolves the ESM entry (Node >= 22 require(esm)). Keep these
// signatures in sync with packages/content/plate-schema.d.mts.
declare module "@zzsh/content/plate" {
  export type PlatePreset = "help" | "update" | "notice" | "legal" | "internal";
  export type PlateNode = { type?: string; text?: string; children?: PlateNode[]; [key: string]: unknown };
  export type PlateDocumentEnvelope = { format: "plate"; schemaVersion: 1; preset: PlatePreset; value: PlateNode[] };
  export type PlateValidationError = { path: string; code: string; message: string };
  export const PRESETS: PlatePreset[];
  export const PALETTE: string[];
  export const BLOCK_TYPES: Record<PlatePreset, string[]>;
  export function marksFor(preset: PlatePreset): string[];
  export function validatePlateDocument(doc: unknown, options: { preset: PlatePreset; mode?: "draft" | "publish" }): { ok: boolean; errors: PlateValidationError[] };
  export function extractPlate(doc: PlateDocumentEnvelope): { plainText: string; toc: { id: string; text: string; level: 2 | 3 }[]; mediaIds: string[]; imageIds: string[]; commentIds: string[]; links: string[] };
  export function canonicalize(value: unknown, depth?: number): string;
  export function plateDigest(doc: PlateDocumentEnvelope): Promise<string>;
  export function toPlateEnvelope(value: unknown, preset: PlatePreset): PlateDocumentEnvelope;
}