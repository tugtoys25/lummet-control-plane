-- 0104: aftermarket notifications
--
--  * notified_status  the status the owner was last told about (or set themselves). The maintenance tick compares it with the live status and
--                     emails the seller about changes they did NOT make: a domain verified and listed, a verification that expired, a
--                     listing approved or declined by an admin. Existing rows start in sync, so nobody is emailed about the past.
--  * review_note      a note an admin writes when declining a listing; it goes to the seller in the email and shows in their dashboard.

ALTER TABLE lummet_aftermarket_domains ADD COLUMN notified_status TEXT;
UPDATE lummet_aftermarket_domains SET notified_status = status WHERE notified_status IS NULL;

ALTER TABLE lummet_listings ADD COLUMN notified_status TEXT;
ALTER TABLE lummet_listings ADD COLUMN review_note TEXT;
UPDATE lummet_listings SET notified_status = status WHERE notified_status IS NULL;
