/**
 * 上架领域门面。实现已按草稿 / 报价 / 审核 / 公开读拆分，共享底座在 publishing-internals。
 * 全部原有导出仍从这里给出，调用方 import 路径不变。
 * 值导出刻意写成可写数据属性而不是 `export {x} from`：后者编译成只读 getter，
 * 会让既有测试的 t.mock.method(publishing, ...) 与直接赋值替换失效；用 let 而非 const
 * 是因为 const 在类型层是只读绑定，测试里的赋值替换会编译不过。
 * 写函数的事务边界不变，仍接收调用方传入的 PoolClient。
 */
import * as internals from "./publishing-internals";
import * as drafts from "./publishing-drafts";
import * as quote from "./publishing-quote";
import * as review from "./publishing-review";
import * as publicRead from "./publishing-public";

export type { SupplyGate, CreditGuaranteeGateSnapshot, SupplyGateReader, PublishingAccount, ListingVersion, ListingPublication, ListingGameRow, ListingPageShared, ListingMediaAssetRow, LegacyTakeoverGradingContext } from "./publishing-internals";
export let unknownSupplyGate = internals.unknownSupplyGate;
export let lockPublishingAccount = internals.lockPublishingAccount;
export let readPublishingAccount = internals.readPublishingAccount;
export let readPublishingAccounts = internals.readPublishingAccounts;
export let readCurrentVersions = internals.readCurrentVersions;
export let readCurrentVersion = internals.readCurrentVersion;
export let checkAccountRevision = internals.checkAccountRevision;
export let currentVersion = internals.currentVersion;
export let readListingPublication = internals.readListingPublication;
export let isRetiredMigratedAccount = internals.isRetiredMigratedAccount;
export let publicationBlockers = internals.publicationBlockers;
export let assertEditable = internals.assertEditable;
export let readAccountMediaBindings = internals.readAccountMediaBindings;
export let readDeclaration = internals.readDeclaration;
export let assertCurrentRelease = internals.assertCurrentRelease;
export let publicMediaCategory = internals.publicMediaCategory;

export let createListingDraft = drafts.createListingDraft;
export let saveListingDraft = drafts.saveListingDraft;

export type { IncomePreviewRelease, IncomePreviewItem, PreviewPricingContext } from "./publishing-quote";
export let readDepositRecommendation = quote.readDepositRecommendation;
export let parseIncomePreviewInventory = quote.parseIncomePreviewInventory;
export let resolveIncomePreviewRelease = quote.resolveIncomePreviewRelease;
export let readIncomePreviewContext = quote.readIncomePreviewContext;
export let projectResourceIncomePreview = quote.projectResourceIncomePreview;
export let readResourceIncomePreview = quote.readResourceIncomePreview;
export let quoteListing = quote.quoteListing;
export let freezePresentationSkin = quote.freezePresentationSkin;

export let acceptListingRules = review.acceptListingRules;
export let publicationWaiverRevision = review.publicationWaiverRevision;
export let submitListing = review.submitListing;
export let withdrawListing = review.withdrawListing;
export let reviewListing = review.reviewListing;
export let delistListing = review.delistListing;
export let restrictListing = review.restrictListing;
export let evaluatePublication = review.evaluatePublication;
export let evaluatePricePreviewPublication = review.evaluatePricePreviewPublication;

export type { ListingDetailPrefetch, PublicListingMemo, PublicAvailabilityState, PublicListingReadMode } from "./publishing-public";
export let boundBaseRenterRatio = publicRead.boundBaseRenterRatio;
export let withPublicListingSnapshot = publicRead.withPublicListingSnapshot;
export let listingPageShared = publicRead.listingPageShared;
export let listingCandidatePage = publicRead.listingCandidatePage;
export let publicListingMemo = publicRead.publicListingMemo;
export let readPresentation = publicRead.readPresentation;
export let publicationHasUnknownFacts = publicRead.publicationHasUnknownFacts;
export let readDraftSkinSummary = publicRead.readDraftSkinSummary;
export let publicListingAttributes = publicRead.publicListingAttributes;
export let declaredTitleOrNull = publicRead.declaredTitleOrNull;
export let publicListingBasis = publicRead.publicListingBasis;
export let orderAccountTitleFact = publicRead.orderAccountTitleFact;
export let publicAvailability = publicRead.publicAvailability;
export let readPublicListingSnapshot = publicRead.readPublicListingSnapshot;
export let readPublicListing = publicRead.readPublicListing;
export let publicDepositProjection = publicRead.publicDepositProjection;
export let listingDetail = publicRead.listingDetail;
