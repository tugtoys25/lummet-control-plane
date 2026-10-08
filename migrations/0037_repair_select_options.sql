-- Repairs the contact "topic" and demo "properties" dropdowns when their option
-- lists lost their line breaks (one option per line is required).
-- Idempotent: a list that already has line breaks (including one an admin edited) is left alone.
UPDATE lummet_form_fields
SET options = 'Platform question' || CAST(X'0A' AS TEXT) || 'Partnership opportunity' || CAST(X'0A' AS TEXT) || 'Technology licensing' || CAST(X'0A' AS TEXT) || 'Other'
WHERE form_key = 'contact' AND field_key = 'topic' AND options IS NOT NULL AND instr(options, CAST(X'0A' AS TEXT)) = 0;
UPDATE lummet_form_fields
SET options = '1' || CAST(X'0A' AS TEXT) || '2 to 5' || CAST(X'0A' AS TEXT) || '6 to 10' || CAST(X'0A' AS TEXT) || 'More than 10'
WHERE form_key = 'demo' AND field_key = 'properties' AND options IS NOT NULL AND instr(options, CAST(X'0A' AS TEXT)) = 0;
