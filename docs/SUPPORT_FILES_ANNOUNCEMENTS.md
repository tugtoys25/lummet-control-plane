# Support files and announcements (migration 0107)

## Files on support tickets
- Customers (any member) and staff can attach photos, screenshots and documents to a request or a reply: up to 5 files per message, 10 MB each.
- Any extension is accepted except programs and scripts (`worker/private-files.js` `BLOCKED`: exe, js, html, svg, sh, ps1 …). `.webapp` is accepted as a plain download.
- Image extensions (png, jpg, jpeg, gif, webp) must really be that image (checked from the bytes). Images display inline; every other file is a download with a neutral content type, `nosniff` and a sandboxed CSP.
- Files live in the `PLATFORM_MEDIA` bucket under `private/…`; the public `/brand-media` route cannot serve them. Customers reach them at `/api/organizations/:id/support/files/:fileId` (members only), staff at `/api/platform/saas/files/:id`.
- Uploads not attached to a message within a day are deleted by the maintenance tick. Erasing an organization deletes its files from storage first.
- Without `PLATFORM_MEDIA` bound, uploads answer `file_storage_not_configured`; text-only requests still work.

## Announcements (staff console > Customer care > Announcements)
- Audience: everyone, one person (email), one organization, one site, or billing contacts (owners and billing role; one organization or all).
- Where: customer dashboard (Announcements, unread badge) and/or email. Preview shows who it reaches before sending.
- Body: HTML (cleaned: no script, handlers, styles, iframes; only http(s)/mailto/tel/relative links) or plain text. Photos can be placed in the text; other files are listed as downloads.
- Email goes through the normal outbox (`queueEmail`, template `announcement`), 40 people per tick plus a first batch at send time, one email per person (`dedupeKey`). Attachments in email are signed links (`/f/:id/:signature`) and need `PORTAL_BASE_URL`.
- The automatic billing and reminder emails are not touched.
