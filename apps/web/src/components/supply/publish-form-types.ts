import type { ReactNode } from "react";
import type {
  DepositRecommendation,
  DraftInput,
  FullPayoutTerms,
  FullPayoutTermsAcceptance,
  MySupply,
  PublishingCatalog,
  PublishingOptions,
  ResourceIncomePreview,
  OwnerIncomePreview,
  OwnerIncomePreviewInput,
  RentalMode,
  SkinOwnerKind,
  SupplyGame,
} from "../../lib/supply-types";
import type { PublishMode } from "../../lib/service-navigation";
import type { SupplyWriteIntent } from "../../lib/supply-write-intent";

export type PublishFormProps = { mode: PublishMode; gameCode?: string; accountId?: string; editRequested?: boolean };
export type RegionOption = { province: string; city: string };
export type SessionId = string | null | undefined;
export type MediaPurpose = "ACCOUNT_DISPLAY" | "ACCOUNT_EVIDENCE";
export type IdentityState = "checking" | "confirmed" | "failed" | "guest";
export type RequestContext = { epoch: number; identity: SessionId; accountId?: string; gameId: string };
export type AmmoReview = { itemId: string; quantity: string; context: RequestContext; resume?: () => void };
export type RetryTask = { context: RequestContext; busy: string; run: () => Promise<void> };
export type WriteIntent = { action: string; context: RequestContext; persisted?: SupplyWriteIntent; run: () => Promise<void | boolean> };
export type DraftRequest = { context: RequestContext; accountId: string; body: DraftInput & { expectedRevision: string }; key: string };
export type MediaCategory = "SHOWCASE" | "PENALTY";

export type MediaEntry = {
  id: string;
  purpose: MediaPurpose;
  category?: MediaCategory;
  file?: File;
  transport?: "OSS_POST";
  assetId?: string;
  reviewState?: string;
  publicDisplayEligible?: boolean;
  publiclyReadable?: boolean;
  previewUrl?: string;
  bindingSaved: boolean;
  status: "uploading" | "bound" | "failed";
  intentKey: string;
  uploadKey: string;
  error?: string;
  context: RequestContext;
};

export type SkinQuery = { q?: string; categoryId?: string; ownerKind?: SkinOwnerKind; rarityCode?: string; ownerId?: string; cursor?: string };
export type PublishGroupId = "account" | "assets" | "terms" | "media";
export type OptionsAvailability = "pending" | "ready" | "unavailable" | "failed";
export type NavigationIntent = { message: string; label: string; run: () => void; cancel?: () => void };
export type UiProblem = { group: PublishGroupId; message: string; target?: string };

export type RecommendationInputs = Extract<DepositRecommendation, { available: true }>["inputs"];
export type RecommendationBinding = {
  accountId: string;
  accountRevision: string;
  versionId: string;
  versionRevision: string;
  ruleReleaseId: string;
  inputs: RecommendationInputs;
  mismatch: boolean;
};
