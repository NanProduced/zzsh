-- Preserve the operator identity separately from renter and timeout cancellations.
ALTER TABLE zzsh_order.rental_order
  DROP CONSTRAINT rental_order_cancel_reason_check,
  ADD CONSTRAINT rental_order_cancel_reason_check CHECK(cancel_reason IN
    ('USER','TIMEOUT','PRESTART_TERMINATED','MANUAL_CLOSE','SUPPORT_CANCELLED_REFUND','SUPPORT_UNPAID')),
  DROP CONSTRAINT rental_order_payment_shape,
  ADD CONSTRAINT rental_order_payment_shape CHECK(
    (status IN ('PAID','COMPLETED') AND paid_confirmation_id IS NOT NULL AND paid_at IS NOT NULL)
    OR (status='PENDING_PAYMENT' AND paid_confirmation_id IS NULL AND paid_at IS NULL)
    OR (status='CANCELLED' AND (
      (cancel_reason IN ('PRESTART_TERMINATED','MANUAL_CLOSE','SUPPORT_CANCELLED_REFUND') AND paid_confirmation_id IS NOT NULL AND paid_at IS NOT NULL)
      OR (cancel_reason IN ('USER','TIMEOUT','SUPPORT_UNPAID') AND paid_confirmation_id IS NULL AND paid_at IS NULL))));
