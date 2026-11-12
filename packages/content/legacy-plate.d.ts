import type { ContentResource } from "./index";
import type { PlateDocumentEnvelope } from "./plate-schema.d.mts";
export declare function projectLegacyResource(payload: unknown): ContentResource | null;
export declare function projectLegacyUpdate(body: string, format: unknown): PlateDocumentEnvelope;
