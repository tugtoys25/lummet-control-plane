-- v7G: a comparison key for customer email addresses so one person cannot get a new free trial per "+tag" or Gmail dot
-- variant. customer_users.email is untouched (it is what the person signs in with). The key is NOT unique.
-- Rules (mirrored by worker/email-key.js): lower case, strip "+tag" from the local part, and for gmail.com / googlemail.com
-- remove dots from the local part and use gmail.com.
ALTER TABLE customer_users ADD COLUMN email_key TEXT;

UPDATE customer_users SET email_key = lower(trim(email)) WHERE email_key IS NULL;

UPDATE customer_users
   SET email_key = substr(email_key, 1, instr(email_key, '+') - 1) || substr(email_key, instr(email_key, '@'))
 WHERE instr(email_key, '+') > 1 AND instr(email_key, '+') < instr(email_key, '@');

UPDATE customer_users
   SET email_key = replace(substr(email_key, 1, instr(email_key, '@') - 1), '.', '') || '@gmail.com'
 WHERE instr(email_key, '@') > 1 AND (substr(email_key, instr(email_key, '@')) = '@gmail.com' OR substr(email_key, instr(email_key, '@')) = '@googlemail.com');

CREATE INDEX IF NOT EXISTS idx_customer_users_email_key ON customer_users(email_key);
