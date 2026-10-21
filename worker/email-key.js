// A comparison key for an email address (v7G), used only to notice the same person coming back under a trivially
// different address. Not an identity and never shown or used to sign in: customer_users.email stays what was typed.
//
//   lower case; "+tag" removed from the local part (a+b@x.com -> a@x.com); and for Gmail, where dots in the local part
//   are ignored and googlemail.com is the same mailbox, dots removed and the domain unified (A.B+c@googlemail.com -> ab@gmail.com).
//
// migrations/0042_customer_email_key.sql computes the same thing in SQL for existing rows; a test checks they agree.
export function emailKey(email) {
  const e = String(email || "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}
