// Public legal document metadata. The formal text and versions live in the API
// (zzsh_content.legal_document_version); this module only names the two public
// reading routes and provides the honest pre-publication state.
export type LegalDocId = "terms" | "privacy";

export type LegalDocStatus = "PENDING" | "PUBLISHED";

export type LegalDocumentRecord = {
  doc: LegalDocId;
  title: string;
  version: string | null;
  effectiveAt: string | null;
  status: LegalDocStatus;
  /** Reading pages render the server-provided body; the static registry never invents one. */
  body: string | null;
  note: string;
};

export const legalDocuments: readonly LegalDocumentRecord[] = [
  {
    doc: "terms",
    title: "平台服务协议",
    version: null,
    effectiveAt: null,
    status: "PENDING",
    body: null,
    note: "正式内容尚未提供，暂无法阅读正式协议。",
  },
  {
    doc: "privacy",
    title: "用户隐私政策",
    version: null,
    effectiveAt: null,
    status: "PENDING",
    body: null,
    note: "正式内容尚未提供，暂无法阅读正式协议。",
  },
];

const byDoc = new Map(legalDocuments.map((record) => [record.doc, record]));

export function listLegalDocuments(): readonly LegalDocumentRecord[] {
  return legalDocuments;
}

export function isLegalDocId(doc: string): doc is LegalDocId {
  return byDoc.has(doc as LegalDocId);
}

export function getLegalDocument(doc: string): LegalDocumentRecord | undefined {
  return byDoc.get(doc as LegalDocId);
}

export function getLegalDocumentSibling(doc: LegalDocId): LegalDocumentRecord {
  return legalDocuments.find((record) => record.doc !== doc)!;
}
