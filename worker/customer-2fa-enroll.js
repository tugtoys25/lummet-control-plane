// Round 2fa-enroll (release 2.6.0.16): the customer-facing authenticator enrollment page.
//   CUSTOMER_2FA_ENROLL_PAGE=off  (default, also unset or invalid) /app/security/2fa answers 404 and the org 2FA notice has no link.
//   CUSTOMER_2FA_ENROLL_PAGE=on   the page is served to any signed-in customer, including a session an organization policy restricts.
// The page only drives the existing /api/customer/2fa/* routes; it adds no new API, no migration and no stored data.
export function customer2faEnrollMode(env) {
  const v = String((env && env.CUSTOMER_2FA_ENROLL_PAGE) || "off").trim().toLowerCase();
  return v === "on" ? "on" : "off";
}
export const ENROLL_PAGE_PATH = "/app/security/2fa";
