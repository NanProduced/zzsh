import type { OrderSettlementStage, OrderRequestError } from "@/lib/order-client";

export type PanelError = { message: string; retryable: boolean };

export type WriteOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "unknown"; message: string }
  | { status: "unauthorized"; error: OrderRequestError }
  | { status: "blocked"; message: string }
  | { status: "recovery-unresolved"; error: OrderRequestError }
  | { status: "definitive"; error: OrderRequestError };

/** Facts the detail banner may state, and only what the settlement read actually returned. */
export type OrderStageFacts = {
  rentalStarted: boolean;
  phase: "RENTING" | "INTAKE_PENDING" | "DECISION_PENDING" | "DECISION_REJECTED" | "DECISION_WAITING" | "POSTED";
  early: boolean;
  postedAt: string | null;
  openingVersionNo: string | null;
  settlementVersionNo: string | null;
  rejectedBy?: string | null;
  openingConfirmedAt: string | null;
  myAck: boolean;
  otherAck: boolean;
  /** Server-owned stage when the settlement read supplies one; null on older projections. */
  stageCode: OrderSettlementStage["code"] | null;
  viewerActionRequired: boolean;
  /** Frozen per-order auto-confirm deadline; null when the server recorded none. */
  autoConfirmDueAt: string | null;
  /** Opening generation outcome; null when the read omits the field. */
  openingGenerationState: "CREATED" | "REVIEW_REQUIRED" | null;
  openingGenerationRecoveryRequired: boolean;
  feeReconfirmationRequired?: boolean;
  /** This party's final settlement figure, straight from the posting's final column. `null` until posted. */
  settled: { label: string; text: string } | null;
};

export type SettlementFocus = "opening" | "settlement" | "decision";
