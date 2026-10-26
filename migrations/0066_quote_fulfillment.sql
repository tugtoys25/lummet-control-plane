-- Phase 5.6: accepted quote -> staff-approved draft invoice. Reuses quotes.stripe_invoice_id and status 'invoiced'.
ALTER TABLE quotes ADD COLUMN fulfillment_claimed_at TEXT;
ALTER TABLE quotes ADD COLUMN fulfilled_by TEXT;
ALTER TABLE quotes ADD COLUMN fulfilled_at TEXT;
