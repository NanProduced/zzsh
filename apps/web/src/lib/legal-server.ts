import type { LegalDocId } from "@/content/legal/documents";
import { isHttpOrigin } from "@/lib/user-proxy";

const local = process.env.NODE_ENV !== "production";
const apiOrigin = process.env.ZZSH_API_ORIGIN ?? (local ? "http://127.0.0.1:3102" : "");
const webOrigin = process.env.ZZSH_WEB_ORIGIN ?? (local ? "http://127.0.0.1:3100" : "");

export type LegalDocumentView =
  | { state: "PENDING"; title: string }
  | {
      state: "PUBLISHED";
      document: {
        id: string;
        docType: "PLATFORM_TERMS" | "PLATFORM_PRIVACY";
        title: string;
        body: string;
        digest: string;
        effectiveAt: string;
      };
    }
  | { state: "UNAVAILABLE" };

export async function readLegalDocument(doc: LegalDocId, version?: string): Promise<LegalDocumentView> {
  if (!isHttpOrigin(apiOrigin) || !isHttpOrigin(webOrigin)) return { state: "UNAVAILABLE" };
  try {
    const url = new URL(`/api/v1/legal-documents/${doc}`, apiOrigin);
    if (version !== undefined) url.searchParams.set("version", version);
    const response = await fetch(url, {
      headers: { origin: webOrigin, accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { state: "UNAVAILABLE" };
    const body = await response.json() as LegalDocumentView;
    if (body.state === "PENDING" && typeof body.title === "string") return body;
    if (body.state === "PUBLISHED" && body.document && typeof body.document.body === "string") return body;
    return { state: "UNAVAILABLE" };
  } catch {
    return { state: "UNAVAILABLE" };
  }
}
