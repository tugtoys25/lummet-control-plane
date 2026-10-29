// Cache-busting token for the public site's static CSS/JS (/static/css|js/*). Bump it whenever a file under
// public/static/css or public/static/js changes: those URLs are served "immutable", so the token in the URL is
// what makes a browser fetch the new file. scripts/check-asset-version.mjs fails the build if the files changed and
// this value did not.
export const ASSET_VERSION = "ui2";
