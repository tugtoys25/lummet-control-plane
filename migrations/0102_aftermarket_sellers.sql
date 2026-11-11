-- 0102: seller accounts for the domain aftermarket
--
-- A listing made from the customer portal (Aftermarket tab) belongs to the seller's organization and the person who made it,
-- so the seller can sign in, edit the price and description, see enquiry activity and manage DNS for a nameserver-verified
-- domain. Listings made earlier (public form, admin) have no organization and are unchanged.

ALTER TABLE lummet_aftermarket_domains ADD COLUMN organization_id TEXT;
ALTER TABLE lummet_aftermarket_domains ADD COLUMN owner_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_lummet_aftermarket_org ON lummet_aftermarket_domains(organization_id, status);
