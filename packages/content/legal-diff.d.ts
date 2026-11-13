export type FixedDocumentBlockChange = {
  status: "ADDED" | "REMOVED" | "CHANGED" | "UNCHANGED";
  before: string | null;
  after: string | null;
};
export function diffDocumentBlocks(before: string, after: string): FixedDocumentBlockChange[];
