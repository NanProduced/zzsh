// 法律文档版本化登记（公开阅读页的唯一内容源）。
// 事实状态：正式法律文本未交付，两条记录均为 PENDING，version/effectiveAt/body 一律为 null；
// 不编造正文、版本号或生效日期。文本交付后只需把对应记录更新为 PUBLISHED 并补齐有据字段。

export type LegalDocId = "terms" | "privacy";

export type LegalDocStatus = "PENDING" | "PUBLISHED";

export type LegalDocBlock =
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered?: boolean; items: readonly string[] }
  | { type: "heading"; text: string };

export type LegalDocumentRecord = {
  doc: LegalDocId;
  title: string;
  /** 有据可查的版本号；未发布必须为 null */
  version: string | null;
  /** 生效日期 ISO YYYY-MM-DD；未发布必须为 null */
  effectiveAt: string | null;
  status: LegalDocStatus;
  /** 结构化正文；PENDING 必须为 null，不编造占位正文 */
  body: readonly LegalDocBlock[] | null;
  /** 面向读者的状态说明（PENDING 页展示） */
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

// Map 查询避免 __proto__/constructor 等原型键误判为有效文档
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

/** 互链用：除自身外的另一份登记记录 */
export function getLegalDocumentSibling(doc: LegalDocId): LegalDocumentRecord {
  return legalDocuments.find((record) => record.doc !== doc)!;
}
