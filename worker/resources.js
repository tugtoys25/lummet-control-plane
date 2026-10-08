// =====================================================
// RESOURCE CONTRACT
// Drives the generic CRUD screens. Every field/type/
// required/lockOnEdit rule below was verified directly
// against the tenant's own code — not guessed:
//
//   - en/worker/database/*.js   the actual INSERT/UPDATE
//                                column lists and bind order
//   - en/worker/api.js           the actual validate([...])
//                                required-field lists
//   - en/static/js/admin.js      the tenant's own admin
//                                frontend's real serialization
//                                (pros/cons newline-splitting,
//                                faq_json sent as a raw string,
//                                seo fields null-not-empty, etc.)
//
// Field types and what they mean for serialization (see
// crud.js's coerceFieldValue — this is where each type's
// wire format is actually implemented):
//
//   text/select   string, or null if empty (matches the
//                 tenant's own `formData.get(x) || null`
//                 convention for optional fields)
//   textarea      same as text, just a bigger box
//   number        real number, or null if empty
//   checkbox      real boolean
//   list          newline-separated textarea -> real JS array
//                 (e.g. reviews.pros/cons, casinos.features —
//                 the DB layer JSON.stringify()s these itself)
//   json_object   JSON textarea -> parsed object/array (the DB
//                 layer JSON.stringify()s it again itself, e.g.
//                 pages.content_json — sending an object here
//                 avoids double-encoding)
//   json_raw      JSON textarea -> the RAW STRING is sent as-is
//                 (e.g. reviews.faq_json, components.settings_json,
//                 authors.social_links — the DB layer does NOT
//                 re-encode these, it stores the string verbatim)
//   richtext      HTML string via the built-in rich text editor
//   media         numeric media_library id, via the media picker
//
// `lockOnEdit: true` means the tenant's own update function does
// NOT include that column in its UPDATE statement at all — it is
// genuinely immutable after creation (verified per-resource, not
// assumed). Fields without `lockOnEdit` that ARE editable but also
// double as the record's identity (e.g. casinos.slug, news.slug,
// authors.slug) support rename-on-edit exactly like the tenant's
// own admin — the URL/route param is the OLD value used to find
// the row, and the field's new value in the body becomes the new
// identity, verified against updateCasino/updateNews/updateAuthor.
// =====================================================

export const RESOURCES = {
  casinos: {
    label: "Casinos",
    section: "Content",
    idField: "slug",
    supportsCreate: true,
    supportsDelete: true,
    listColumns: [
      { key: "name", label: "Name" },
      { key: "slug", label: "Slug" },
      { key: "status", label: "Status" },
      { key: "featured", label: "Featured", type: "bool" },
      { key: "rating", label: "Rating" }
    ],
    fields: [
      { name: "slug", label: "Slug", type: "text", required: true },
      { name: "name", label: "Name", type: "text", required: true },
      { name: "affiliate_url", label: "Affiliate URL", type: "text", required: true },
      // website_url is NOT NULL in the tenant's casinos table (schema.sql), so
      // it must be required here too. It was previously optional, which meant a
      // create that omitted it (dashboard form left blank, or the AI chat) was
      // accepted by this side and then rejected by D1 with
      // "NOT NULL constraint failed: casinos.website_url".
      { name: "website_url", label: "Website URL", type: "text", required: true },
      { name: "logo", label: "Logo URL", type: "text" },
      { name: "rating", label: "Rating", type: "number", step: "0.1" },
      { name: "bonus_title", label: "Bonus title", type: "text" },
      { name: "bonus_value", label: "Bonus value", type: "text" },
      { name: "features", label: "Features", type: "list", hint: "one per line" },
      { name: "status", label: "Status", type: "select", options: ["draft", "published"] },
      { name: "featured", label: "Featured", type: "checkbox" },
      { name: "sort_order", label: "Sort order", type: "number" },
      { name: "logo_media_id", label: "Logo image", type: "media" },
      { name: "hero_image_media_id", label: "Hero image", type: "media" },
      // Not real columns on `casinos` — the tenant's Super API
      // (handleGetCasino/handleCreateCasino/handleUpdateCasino)
      // reads/writes these through casino_categories and geo_rules
      // respectively, and attaches them to the record as
      // category_ids / geo_rules so this generic form can round-trip
      // them like any other field.
      {
        name: "category_ids",
        label: "Categories",
        type: "multi_select",
        optionsResource: "categories",
        optionValueKey: "id",
        optionLabelKey: "name",
        castTo: "number"
      },
      // Mirrors category_ids exactly -- see handlers.js's handleGetCasino/
      // handleCreateCasino/handleUpdateCasino: reads/writes through the
      // casino_payment_methods join table, not a real `casinos` column.
      // Previously this join had a database layer (payment-methods.js's
      // setCasinoPaymentMethods/getPaymentMethodIdsForCasino) but no
      // Super API wiring and no form field at all.
      {
        name: "payment_method_ids",
        label: "Payment methods",
        type: "multi_select",
        optionsResource: "payment-methods",
        optionValueKey: "id",
        optionLabelKey: "name",
        castTo: "number"
      },
      {
        name: "geo_rules",
        label: "Countries",
        type: "geo_rules",
        optionsResource: "countries",
        optionValueKey: "code",
        optionLabelKey: "name",
        hint: "which countries can see/access this casino"
      },
      { name: "seo_title", label: "SEO title", type: "text" },
      { name: "seo_description", label: "SEO description", type: "textarea" }
    ]
  },

  reviews: {
    label: "Reviews",
    section: "Content",
    idField: "slug",
    supportsCreate: true,
    supportsDelete: true,
    listColumns: [
      { key: "title", label: "Title" },
      { key: "slug", label: "Slug" },
      { key: "casino_slug", label: "Casino" },
      { key: "rating", label: "Rating" },
      { key: "published", label: "Published", type: "bool" }
    ],
    fields: [
      // Verified: updateReview's SET clause does not include slug,
      // casino_slug, or country_code — genuinely immutable post-create.
      { name: "slug", label: "Slug", type: "text", required: true, lockOnEdit: true },
      { name: "casino_slug", label: "Casino slug", type: "text", required: true, lockOnEdit: true },
      { name: "country_code", label: "Country code", type: "text", lockOnEdit: true },
      { name: "title", label: "Title", type: "text", required: true },
      { name: "content", label: "Content", type: "richtext", required: true },
      { name: "overview", label: "Overview", type: "richtext" },
      { name: "games", label: "Games", type: "richtext" },
      { name: "bonuses", label: "Bonuses", type: "richtext" },
      { name: "payments", label: "Payments", type: "richtext" },
      { name: "licenses", label: "Licenses", type: "richtext" },
      { name: "verdict", label: "Verdict", type: "richtext" },
      { name: "pros", label: "Pros", type: "list", hint: "one per line" },
      { name: "cons", label: "Cons", type: "list", hint: "one per line" },
      { name: "faq_json", label: "FAQ", type: "json_raw" },
      { name: "rating", label: "Rating", type: "number", step: "0.1" },
      { name: "author_id", label: "Author", type: "resource_select", optionsResource: "authors", optionValueKey: "id", optionLabelKey: "name" },
      { name: "seo_title", label: "SEO title", type: "text" },
      { name: "seo_description", label: "SEO description", type: "textarea" }
    ]
  },

  news: {
    label: "News",
    section: "Content",
    idField: "slug",
    supportsCreate: true,
    supportsDelete: true,
    listColumns: [
      { key: "title", label: "Title" },
      { key: "slug", label: "Slug" },
      { key: "published", label: "Published", type: "bool" },
      { key: "published_at", label: "Published at" }
    ],
    fields: [
      // Verified: updateNews DOES rename (slug is in its SET clause).
      { name: "slug", label: "Slug", type: "text", required: true },
      { name: "title", label: "Title", type: "text", required: true },
      { name: "content", label: "Content", type: "richtext", required: true },
      { name: "excerpt", label: "Excerpt", type: "textarea" },
      { name: "author", label: "Author name", type: "text" },
      { name: "author_id", label: "Author", type: "resource_select", optionsResource: "authors", optionValueKey: "id", optionLabelKey: "name" },
      { name: "tags", label: "Tags", type: "text", hint: "comma-separated" },
      { name: "featured_image", label: "Featured image", type: "media" },
      // IMPORTANT: updateNews defaults published to 1 whenever the
      // field is absent from the payload — omitting this checkbox
      // from the form would silently force-republish every edited
      // post. It must always be included and always sent.
      { name: "published", label: "Published", type: "checkbox" },
      { name: "published_at", label: "Published at", type: "text", hint: "ISO date, optional" },
      { name: "ad_mode", label: "Ad mode", type: "select", options: ["auto", "disable"] },
      { name: "ai_generated", label: "AI generated", type: "checkbox" },
      { name: "seo_title", label: "SEO title", type: "text" },
      { name: "seo_description", label: "SEO description", type: "textarea" }
    ]
  },

  updates: {
    label: "Updates",
    section: "Content",
    idField: "id",
    supportsCreate: true,
    supportsDelete: true,
    listColumns: [
      { key: "title", label: "Title" },
      { key: "slug", label: "Slug" },
      { key: "published", label: "Published", type: "bool" },
      { key: "featured", label: "Featured", type: "bool" }
    ],
    fields: [
      { name: "slug", label: "Slug", type: "text", required: true },
      { name: "title", label: "Title", type: "text", required: true },
      { name: "content", label: "Content", type: "richtext", required: true },
      { name: "excerpt", label: "Excerpt", type: "textarea" },
      { name: "author_id", label: "Author", type: "resource_select", optionsResource: "authors", optionValueKey: "id", optionLabelKey: "name" },
      { name: "featured_image", label: "Featured image", type: "media" },
      { name: "published", label: "Published", type: "checkbox" },
      { name: "featured", label: "Featured", type: "checkbox" },
      { name: "published_at", label: "Published at", type: "text", hint: "ISO date, optional" },
      { name: "seo_title", label: "SEO title", type: "text" },
      { name: "seo_description", label: "SEO description", type: "textarea" }
    ]
  },

  pages: {
    label: "Pages",
    section: "Content",
    idField: "slug",
    supportsCreate: true,
    supportsDelete: true,
    listColumns: [
      { key: "title", label: "Title" },
      { key: "slug", label: "Slug" },
      { key: "type", label: "Type" },
      { key: "published", label: "Published", type: "bool" }
    ],
    fields: [
      // Verified: updatePage's SET clause is ONLY title,
      // content_json, seo_title, seo_description, author_id.
      // slug/type/template/published are genuinely frozen after
      // creation on this tenant.
      { name: "slug", label: "Slug", type: "text", required: true, lockOnEdit: true },
      { name: "type", label: "Type", type: "text", required: true, lockOnEdit: true },
      { name: "template", label: "Template", type: "text", required: true, lockOnEdit: true },
      { name: "title", label: "Title", type: "text", required: true },
      { name: "content_json", label: "Content", type: "json_object" },
      { name: "author_id", label: "Author", type: "resource_select", optionsResource: "authors", optionValueKey: "id", optionLabelKey: "name" },
      { name: "seo_title", label: "SEO title", type: "text" },
      { name: "seo_description", label: "SEO description", type: "textarea" }
    ]
  },

  categories: {
    label: "Categories",
    section: "Content",
    idField: "slug",
    supportsCreate: true,
    supportsDelete: true,
    listColumns: [
      { key: "name", label: "Name" },
      { key: "slug", label: "Slug" }
    ],
    fields: [
      // Verified: updateCategory's SET clause does not include slug.
      { name: "slug", label: "Slug", type: "text", required: true, lockOnEdit: true },
      { name: "name", label: "Name", type: "text", required: true },
      { name: "description", label: "Description", type: "textarea" },
      { name: "seo_title", label: "SEO title", type: "text" },
      { name: "seo_description", label: "SEO description", type: "textarea" }
    ]
  },

  countries: {
    label: "Countries",
    section: "Content",
    idField: "code",
    supportsCreate: true,
    supportsDelete: true,
    listColumns: [
      { key: "name", label: "Name" },
      { key: "code", label: "Code" },
      { key: "legal_status", label: "Legal status" },
      {
        key: "published",
        label: "Status",
        toggle: {
          onLabel: "Published",
          offLabel: "Draft",
          pairField: "status",
          pairOnValue: "published",
          pairOffValue: "draft"
        }
      }
    ],
    fields: [
      { name: "code", label: "Code", type: "text", required: true, lockOnEdit: true },
      { name: "name", label: "Name", type: "text", required: true },
      { name: "currency", label: "Currency", type: "text" },
      { name: "language", label: "Language", type: "text" },
      { name: "legal_status", label: "Legal status", type: "text" },
      { name: "seo_title", label: "SEO title", type: "text" },
      { name: "seo_description", label: "SEO description", type: "textarea" },
      { name: "is_featured", label: "Featured on /en/country directory", type: "select", options: ["0", "1"] },
      { name: "featured_position", label: "Featured position", type: "number", hint: "Lower shows first" },
      { name: "tier", label: "Tier", type: "select", options: ["1", "2", "3"], hint: "1=Deep coverage, 2=Secondary, 3=Directory only — planning label only" }
    ]
  },

  research: {
    label: "Research Zone",
    section: "Content",
    idField: "id",
    supportsCreate: true,
    supportsDelete: true,
    listColumns: [
      { key: "type", label: "Type" },
      { key: "title", label: "Title" },
      { key: "slug", label: "Slug" },
      { key: "status", label: "Status" },
      { key: "published", label: "Published", type: "bool" },
      { key: "featured", label: "Featured", type: "bool" }
    ],
    fields: [
      // Verified against en/worker/database/research.js: updateResearchItem's
      // SET clause includes every column below (nothing is genuinely
      // frozen post-create the way pages.slug/casinos.affiliate_url
      // are elsewhere) -- type/slug together are the unique key
      // (UNIQUE(type, slug) per migrations/0045_research_core.sql)
      // but both remain editable, same as categories.slug.
      {
        name: "type",
        label: "Type",
        type: "select",
        required: true,
        options: ["report", "country", "regulator", "topic", "development", "legislation", "licence"],
        hint: "controls the public URL/template — see docs/research/"
      },
      { name: "slug", label: "Slug", type: "text", required: true },
      { name: "title", label: "Title", type: "text", required: true },
      { name: "subtitle", label: "Subtitle", type: "text" },
      { name: "excerpt", label: "Excerpt", type: "textarea" },
      { name: "content_json", label: "Content", type: "json_object", hint: "{ \"sections\": [...] } — same shape as countries/seo_pages content_json" },
      {
        name: "country_id",
        label: "Country",
        type: "resource_select",
        optionsResource: "countries",
        optionValueKey: "code",
        optionLabelKey: "name",
        hint: "leave blank for multi-country reports or cross-border topics"
      },
      { name: "author_id", label: "Author", type: "resource_select", optionsResource: "authors", optionValueKey: "id", optionLabelKey: "name" },
      {
        name: "status",
        label: "Status",
        type: "select",
        options: [
          "draft", "researching", "source_review", "fact_check",
          "editorial_review", "approved", "published",
          "needs_update", "archived"
        ]
      },
      { name: "published", label: "Published", type: "checkbox" },
      { name: "featured", label: "Featured", type: "checkbox" },
      { name: "robots", label: "Robots", type: "select", options: ["index,follow", "noindex,follow", "noindex,nofollow"] },
      { name: "seo_title", label: "SEO title", type: "text" },
      { name: "seo_description", label: "SEO description", type: "textarea" },
      { name: "seo_keywords", label: "SEO keywords", type: "text" },
      { name: "canonical_url", label: "Canonical URL", type: "text" },
      { name: "og_image", label: "OG image", type: "media" },
      { name: "published_at", label: "Published at", type: "text", hint: "ISO date, optional — auto-stamped on first publish" },
      { name: "last_verified_at", label: "Last verified at", type: "text", hint: "ISO date, optional" },
      { name: "next_review_at", label: "Next review at", type: "text", hint: "ISO date, optional — drives the overdue-review list" }
    ]
  },

  // Newsroom Taxonomy (v12 Super API). Verified against
  // en/worker/database/newsroom-taxonomy.js's KINDS map and
  // saveTaxonomyItem: fields listed per kind are exactly its
  // sanitizer list, nothing more. DELETE archives (active = 0) —
  // these tables never hard-delete rows, so "Delete" in these
  // screens is really "deactivate"; slug is intentionally NOT
  // required — the tenant auto-generates it from name on create if
  // left blank, same convention as casinos/news/authors slugs
  // elsewhere in this file.
  "newsroom-sections": {
    label: "Newsroom Sections",
    section: "Content",
    idField: "id",
    supportsCreate: true,
    supportsDelete: true,
    listColumns: [
      { key: "name", label: "Name" },
      { key: "slug", label: "Slug" },
      { key: "parent_id", label: "Parent ID" },
      { key: "display_order", label: "Order" },
      { key: "active", label: "Active", type: "bool" }
    ],
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "slug", label: "Slug", type: "text", hint: "leave blank to auto-generate from name" },
      { name: "description", label: "Description", type: "textarea" },
      {
        name: "parent_id",
        label: "Parent section",
        type: "resource_select",
        optionsResource: "newsroom-sections",
        optionValueKey: "id",
        optionLabelKey: "name",
        hint: "leave blank for a top-level section — a section cannot be its own ancestor (enforced server-side)"
      },
      { name: "display_order", label: "Display order", type: "number" },
      { name: "seo_title", label: "SEO title", type: "text" },
      { name: "seo_description", label: "SEO description", type: "textarea" },
      { name: "og_image", label: "OG image", type: "media" },
      { name: "active", label: "Active", type: "checkbox" }
    ]
  },

  "newsroom-topics": {
    label: "Newsroom Topics",
    section: "Content",
    idField: "id",
    supportsCreate: true,
    supportsDelete: true,
    listColumns: [
      { key: "name", label: "Name" },
      { key: "slug", label: "Slug" },
      { key: "active", label: "Active", type: "bool" }
    ],
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "slug", label: "Slug", type: "text", hint: "leave blank to auto-generate from name" },
      { name: "description", label: "Description", type: "textarea" },
      { name: "seo_title", label: "SEO title", type: "text" },
      { name: "seo_description", label: "SEO description", type: "textarea" },
      { name: "active", label: "Active", type: "checkbox" }
    ]
  },

  "newsroom-entities": {
    label: "Newsroom Entities",
    section: "Content",
    idField: "id",
    supportsCreate: true,
    supportsDelete: true,
    listColumns: [
      { key: "name", label: "Name" },
      { key: "entity_type", label: "Type" },
      { key: "country_code", label: "Country" },
      { key: "active", label: "Active", type: "bool" }
    ],
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "slug", label: "Slug", type: "text", hint: "leave blank to auto-generate from name" },
      {
        name: "entity_type",
        label: "Type",
        type: "select",
        options: ["company", "operator", "regulator", "person", "organization"],
        hint: "defaults to \"company\" if left blank on create"
      },
      { name: "description", label: "Description", type: "textarea" },
      { name: "logo_media_id", label: "Logo", type: "media" },
      { name: "website_url", label: "Website URL", type: "text" },
      { name: "country_code", label: "Country code", type: "text", hint: "ISO 2-letter code, e.g. GB" },
      {
        name: "casino_id",
        label: "Linked casino",
        type: "resource_select",
        optionsResource: "casinos",
        optionValueKey: "id",
        optionLabelKey: "name",
        hint: "optional — links this entity to an existing casino/operator record instead of duplicating it"
      },
      { name: "seo_title", label: "SEO title", type: "text" },
      { name: "seo_description", label: "SEO description", type: "textarea" },
      { name: "active", label: "Active", type: "checkbox" }
    ]
  },

  "newsroom-series": {
    label: "Newsroom Series",
    section: "Content",
    idField: "id",
    supportsCreate: true,
    supportsDelete: true,
    listColumns: [
      { key: "name", label: "Name" },
      { key: "slug", label: "Slug" },
      { key: "active", label: "Active", type: "bool" }
    ],
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "slug", label: "Slug", type: "text", hint: "leave blank to auto-generate from name" },
      { name: "description", label: "Description", type: "textarea" },
      { name: "image_media_id", label: "Series image", type: "media" },
      { name: "seo_title", label: "SEO title", type: "text" },
      { name: "seo_description", label: "SEO description", type: "textarea" },
      { name: "active", label: "Active", type: "checkbox" }
    ]
  },

  // Research Engine Phase 2 (v14 Super API). Verified against
  // en/worker/database/research-sources.js's createSource/
  // updateSource field lists. Global table — a source is never
  // duplicated per research item, so this is a standalone CRUD
  // screen (not nested under Research Zone). DELETE here is a real
  // hard delete, matching the tenant's own admin route (no
  // citation-count guard). Research Claims (scoped to one research
  // item, with claim<->source evidence attachments) are NOT in this
  // generic CRUD system -- they need a per-item sub-page, same
  // reasoning as Newsroom's article-relations getting its own
  // bespoke page instead of a generic resource -- deferred to a
  // later phase.
  "research-sources": {
    label: "Research Sources",
    section: "Content",
    idField: "id",
    supportsCreate: true,
    supportsDelete: true,
    listColumns: [
      { key: "organisation", label: "Organisation" },
      { key: "source_type", label: "Type" },
      { key: "status", label: "Status" },
      { key: "citation_count", label: "Cited by" }
    ],
    fields: [
      { name: "organisation", label: "Organisation", type: "text", required: true },
      { name: "title", label: "Title", type: "text" },
      { name: "url", label: "URL", type: "text" },
      {
        name: "source_type",
        label: "Type",
        type: "select",
        options: ["regulator", "government", "legislation", "court", "eu_institution",
          "official_register", "operator", "industry_organization", "academic",
          "research_organization", "news", "other"],
        hint: "defaults to \"other\" if left blank"
      },
      {
        name: "country_id",
        label: "Country",
        type: "resource_select",
        optionsResource: "countries",
        optionValueKey: "code",
        optionLabelKey: "name"
      },
      { name: "is_primary", label: "Primary source", type: "checkbox" },
      { name: "document_type", label: "Document type", type: "text" },
      { name: "language", label: "Language", type: "text" },
      { name: "publication_date", label: "Publication date", type: "text", hint: "ISO date, optional" },
      { name: "accessed_at", label: "Accessed at", type: "text", hint: "ISO date, optional" },
      {
        name: "status",
        label: "Status",
        type: "select",
        options: ["active", "broken", "archived"],
        hint: "\"broken\" is normally set by the tenant's own link-health check, not edited by hand"
      },
      { name: "notes", label: "Notes", type: "textarea" }
    ]
  },

  authors: {
    label: "Authors",
    section: "Content",
    idField: "id",
    supportsCreate: true,
    supportsDelete: true,
    listColumns: [
      { key: "name", label: "Name" },
      { key: "slug", label: "Slug" },
      { key: "role", label: "Role" },
      { key: "published", label: "Published", type: "bool" }
    ],
    fields: [
      // Verified: updateAuthor DOES rename (slug is in its SET clause).
      { name: "slug", label: "Slug", type: "text", required: true },
      { name: "name", label: "Name", type: "text", required: true },
      { name: "bio", label: "Bio", type: "textarea" },
      { name: "avatar_url", label: "Avatar URL", type: "text" },
      { name: "role", label: "Role", type: "text" },
      { name: "email", label: "Email", type: "text" },
      { name: "social_links", label: "Social links", type: "json_raw" },
      { name: "published", label: "Published", type: "checkbox" },
      { name: "seo_title", label: "SEO title", type: "text" },
      { name: "seo_description", label: "SEO description", type: "textarea" }
    ]
  },

  media: {
    label: "Media",
    section: "System",
    idField: "id",
    // Create happens through the dedicated upload flow (base64
    // JSON — see client.js/handlers.js), not the generic create
    // form, since it needs a file rather than text fields.
    supportsCreate: false,
    supportsDelete: true,
    listColumns: [
      { key: "filename", label: "Filename" },
      { key: "folder", label: "Folder" },
      { key: "type", label: "Type" },
      { key: "url", label: "URL" }
    ],
    fields: [
      // Verified against updateMediaItem (media_library.js) — the
      // only fields it actually persists.
      { name: "alt_text", label: "Alt text", type: "text" },
      { name: "caption", label: "Caption", type: "text" },
      { name: "folder", label: "Folder", type: "text" }
    ]
  },

  users: {
    label: "Users",
    section: "System",
    idField: "id",
    supportsCreate: false,
    supportsDelete: true,
    roleOnly: true, // Super API only exposes role updates for users
    listColumns: [
      { key: "email", label: "Email" },
      { key: "role", label: "Role" },
      { key: "created_at", label: "Created" }
    ],
    fields: [{ name: "role", label: "Role", type: "text", required: true }]
  },

  components: {
    label: "Components",
    section: "System",
    idField: "id",
    supportsCreate: true,
    supportsDelete: true,
    listColumns: [
      { key: "name", label: "Name" },
      { key: "slug", label: "Slug" },
      { key: "type", label: "Type" },
      { key: "status", label: "Status" }
    ],
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "slug", label: "Slug", type: "text", hint: "auto-generated from name if left blank" },
      { name: "type", label: "Type", type: "text", required: true },
      { name: "title", label: "Title", type: "text" },
      { name: "content", label: "Content", type: "richtext" },
      { name: "settings_json", label: "Settings", type: "json_raw" },
      { name: "status", label: "Status", type: "select", options: ["active", "inactive"] }
    ]
  },

  blocks: {
    label: "Blocks",
    section: "System",
    idField: "id",
    supportsCreate: true,
    supportsDelete: true,
    listColumns: [
      { key: "page_type", label: "Page type" },
      { key: "page_slug", label: "Page slug" },
      { key: "name", label: "Component" },
      { key: "injection_point", label: "Injection point" },
      { key: "enabled", label: "Enabled", type: "bool" }
    ],
    fields: [
      // Verified: updatePageComponentAssignment's SET clause is
      // ONLY position and injection_point — page_type, page_slug,
      // and component_id are genuinely immutable once assigned
      // (assign a new block instead of trying to repoint one).
      { name: "page_type", label: "Page type", type: "select", required: true, lockOnEdit: true, options: ["all", "homepage", "casino", "review", "news", "category", "page", "country", "author"] },
      { name: "page_slug", label: "Page slug", type: "text", required: true, lockOnEdit: true, hint: "'*' matches all pages of this type" },
      { name: "component_id", label: "Component", type: "resource_select", required: true, lockOnEdit: true, optionsResource: "components", optionValueKey: "id", optionLabelKey: "name" },
      { name: "position", label: "Position", type: "number" },
      { name: "injection_point", label: "Injection point", type: "select", options: ["top", "content_top", "content_bottom", "bottom", "sidebar"] },
      { name: "enabled", label: "Enabled", type: "checkbox" }
    ]
  },

  "nav-items": {
    label: "Navigation",
    section: "System",
    idField: "id",
    supportsCreate: true,
    supportsDelete: true,
    listColumns: [
      { key: "label", label: "Label" },
      { key: "url", label: "URL" },
      { key: "location", label: "Location" },
      { key: "enabled", label: "Enabled", type: "bool" }
    ],
    fields: [
      { name: "label", label: "Label", type: "text", required: true, hint: "e.g. Home" },
      { name: "url", label: "URL", type: "text", required: true, hint: "/en or https://..." },
      // Fixed set matching the tenant's own admin dropdown exactly
      // (en/templates/pages/admin/nav.html) — free text here let
      // editors create nav items under a typo'd location that would
      // silently never render anywhere.
      {
        name: "location", label: "Location", type: "select", required: true,
        options: [
          { value: "header", label: "Header" },
          { value: "footer_casinos", label: "Footer — Casinos" },
          { value: "footer_company", label: "Footer — Company" },
          { value: "footer_support", label: "Footer — Support" },
          { value: "footer_legal", label: "Footer — Legal" },
          { value: "mobile", label: "Mobile Bottom Nav" },
          { value: "page", label: "Page Navigation" }
        ],
        hint: "\"Page Navigation\" is the contextual nav shown on individual pages (e.g. Crypto Casinos) — separate from the header/footer"
      },
      // Was a raw "Parent nav item ID" number field — the editor had to
      // already know (or guess) another item's numeric id. Same fix as
      // casino_id/casino_ids elsewhere: a real picker, sourced from this
      // tenant's own nav items.
      {
        name: "parent_id", label: "Parent nav item", type: "resource_select",
        optionsResource: "nav-items", optionValueKey: "id", optionLabelKey: "label",
        hint: "for a submenu item — don't pick this same item as its own parent"
      },
      { name: "position", label: "Position", type: "number", hint: "lower = first" },
      { name: "icon", label: "Icon", type: "text", hint: "optional, text or emoji" },
      { name: "is_external", label: "Opens in a new tab (external link)", type: "checkbox" },
      { name: "enabled", label: "Enabled", type: "checkbox" }
    ]
  },

  banners: {
    label: "Banners",
    section: "System",
    idField: "id",
    supportsCreate: true,
    supportsDelete: true,
    listColumns: [
      { key: "type", label: "Type" },
      { key: "title", label: "Title" },
      { key: "position", label: "Position" },
      { key: "enabled", label: "Enabled", type: "bool" }
    ],
    fields: [
      { name: "type", label: "Type", type: "text", hint: "e.g. announcement" },
      { name: "title", label: "Title", type: "text" },
      { name: "content", label: "Content", type: "richtext" },
      { name: "link", label: "Link URL", type: "text" },
      { name: "button_text", label: "Button text", type: "text" },
      { name: "bg_color", label: "Background color", type: "text", hint: "hex, e.g. #6c5ce7" },
      { name: "text_color", label: "Text color", type: "text", hint: "hex, e.g. #ffffff" },
      { name: "position", label: "Position", type: "select", options: ["top", "bottom"] },
      { name: "dismissible", label: "Dismissible", type: "checkbox" },
      { name: "geo_countries", label: "Countries", type: "text", hint: "comma-separated country codes, blank = all" },
      { name: "start_date", label: "Start date", type: "text", hint: "ISO date, optional" },
      { name: "end_date", label: "End date", type: "text", hint: "ISO date, optional" },
      { name: "enabled", label: "Enabled", type: "checkbox" }
    ]
  },

  // =====================================================
  // Systems 1-3: Affiliate Partner/Program Management, Offer &
  // Bonus Management, Tracking Link Management. Every field/type/
  // required/lockOnEdit rule below verified directly against the
  // tenant's actual code, same discipline as every resource above:
  //   - en/worker/database/affiliate-partners.js, affiliate-programs.js,
  //     affiliate-accounts.js, affiliate-commercial-terms.js, offers.js,
  //     tracking-links.js  (the actual INSERT/UPDATE column lists)
  //   - en/worker/super/handlers-affiliate.js  (the actual
  //     validateRequired([...]) lists this Super API enforces)
  //
  // "commercial-terms" is deliberately create+list only (supportsDelete:
  // false, every field lockOnEdit) -- terms are versioned/immutable by
  // design (see migrations/0023_affiliate_partners_programs.sql).
  // Superseding a term is a two-step action (close the old one, open a
  // new one with a later effective_date), not a field edit, so it is
  // not bolted onto the generic edit-in-place form. "offers" and
  // "tracking-links" are create+update but never delete, matching the
  // tenant's own /api/v1/offer/* and /api/v1/tracking-link/* routes,
  // which likewise have no delete endpoint (status transitions only).
  // =====================================================

  "affiliate-partners": {
    label: "Affiliate Partners",
    section: "Content",
    idField: "id",
    supportsCreate: true,
    supportsDelete: true,
    listColumns: [
      { key: "name", label: "Name" },
      { key: "slug", label: "Slug" },
      { key: "partner_type", label: "Type" },
      { key: "status", label: "Status" }
    ],
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "slug", label: "Slug", type: "text", hint: "leave blank to auto-generate from name" },
      { name: "website", label: "Website", type: "text" },
      { name: "description", label: "Description", type: "textarea" },
      { name: "partner_type", label: "Partner type", type: "select", options: ["network", "direct", "agency", "other"] },
      { name: "status", label: "Status", type: "select", options: ["active", "inactive", "archived"] },
      { name: "contact_name", label: "Primary contact name", type: "text" },
      { name: "contact_email", label: "Primary contact email", type: "text" },
      { name: "contact_phone", label: "Primary contact phone", type: "text" },
      { name: "notes", label: "Notes", type: "textarea" },
      { name: "external_reference", label: "External reference", type: "text", hint: "optional ID in the partner's own system" }
    ]
  },

  "affiliate-programs": {
    label: "Affiliate Programs",
    section: "Content",
    idField: "id",
    supportsCreate: true,
    supportsDelete: true,
    listColumns: [
      { key: "name", label: "Name" },
      { key: "partner_id", label: "Partner ID" },
      { key: "status", label: "Status" }
    ],
    fields: [
      // Verified: updateProgram's SET clause does not include
      // partner_id -- a program cannot be moved to a different
      // partner after creation.
      { name: "partner_id", label: "Partner", type: "resource_select", required: true, lockOnEdit: true, optionsResource: "affiliate-partners", optionValueKey: "id", optionLabelKey: "name" },
      { name: "name", label: "Program name", type: "text", required: true },
      { name: "status", label: "Status", type: "select", options: ["active", "paused", "ended", "archived"] },
      { name: "portal_url", label: "Portal URL", type: "text" },
      { name: "supported_geos", label: "Supported GEOs", type: "list", hint: "one ISO country code per line, blank = no restriction" },
      { name: "reporting_notes", label: "Reporting notes", type: "textarea" },
      { name: "notes", label: "Notes", type: "textarea" },
      // Not a real column -- the Super API reads/writes this
      // through affiliate_program_casinos, same virtual-field
      // pattern as casinos.category_ids above.
      { name: "casino_ids", label: "Covered casinos", type: "multi_select", optionsResource: "casinos", optionValueKey: "id", optionLabelKey: "name", castTo: "number", hint: "a casino can be covered by more than one program at once" }
    ]
  },

  "affiliate-accounts": {
    label: "Affiliate Accounts",
    section: "Content",
    idField: "id",
    supportsCreate: true,
    supportsDelete: true,
    listColumns: [
      { key: "account_name", label: "Account" },
      { key: "program_id", label: "Program ID" },
      { key: "status", label: "Status" }
    ],
    fields: [
      // Verified: updateAccount's SET clause does not include
      // program_id -- an account cannot be reassigned to a
      // different program after creation.
      { name: "program_id", label: "Program", type: "resource_select", required: true, lockOnEdit: true, optionsResource: "affiliate-programs", optionValueKey: "id", optionLabelKey: "name" },
      { name: "account_name", label: "Account name", type: "text", required: true },
      { name: "external_account_id", label: "External account ID", type: "text" },
      { name: "status", label: "Status", type: "select", options: ["active", "inactive", "archived"] },
      { name: "portal_url", label: "Portal URL", type: "text" },
      { name: "credential_reference", label: "Credential reference", type: "text", hint: "a pointer to where the real credential is stored (e.g. a secret-store key name) -- never paste an actual password, token, or API key here" },
      { name: "notes", label: "Notes", type: "textarea" }
    ]
  },

  "commercial-terms": {
    label: "Commercial Terms",
    section: "Content",
    idField: "id",
    supportsCreate: true,
    supportsDelete: false,
    listColumns: [
      { key: "program_id", label: "Program ID" },
      { key: "term_type", label: "Type" },
      { key: "effective_date", label: "Effective" },
      { key: "status", label: "Status" }
    ],
    fields: [
      // Every field below is lockOnEdit: terms are versioned and
      // immutable once created (see handlers-affiliate.js's
      // handleUpdateTerm, which rejects any edit attempt with a
      // 409). The edit screen intentionally becomes read-only as a
      // result -- creating a new term (with a later effective_date)
      // is the only supported way to change commercial terms.
      { name: "program_id", label: "Program", type: "resource_select", required: true, lockOnEdit: true, optionsResource: "affiliate-programs", optionValueKey: "id", optionLabelKey: "name" },
      { name: "account_id", label: "Account (optional -- blank = program-wide)", type: "resource_select", lockOnEdit: true, optionsResource: "affiliate-accounts", optionValueKey: "id", optionLabelKey: "account_name" },
      { name: "casino_id", label: "Casino (optional -- blank = all casinos in this program)", type: "resource_select", lockOnEdit: true, optionsResource: "casinos", optionValueKey: "id", optionLabelKey: "name" },
      { name: "geo_code", label: "GEO (optional, ISO country code)", type: "text", lockOnEdit: true },
      { name: "term_type", label: "Term type", type: "select", required: true, lockOnEdit: true, options: ["cpa", "revshare", "hybrid", "fixed_fee", "custom"] },
      { name: "cpa_amount", label: "CPA amount", type: "number", step: "0.01", lockOnEdit: true },
      { name: "revshare_percent", label: "Revenue share %", type: "number", step: "0.01", lockOnEdit: true },
      { name: "hybrid_cpa_amount", label: "Hybrid CPA amount", type: "number", step: "0.01", lockOnEdit: true },
      { name: "hybrid_revshare_percent", label: "Hybrid revenue share %", type: "number", step: "0.01", lockOnEdit: true },
      { name: "fixed_fee_amount", label: "Fixed fee amount", type: "number", step: "0.01", lockOnEdit: true },
      { name: "currency", label: "Currency", type: "text", lockOnEdit: true },
      { name: "custom_terms_json", label: "Custom terms (JSON)", type: "json_raw", lockOnEdit: true },
      { name: "effective_date", label: "Effective date", type: "text", required: true, hint: "ISO date, e.g. 2026-01-01", lockOnEdit: true },
      { name: "expiry_date", label: "Expiry date", type: "text", hint: "ISO date, blank = open-ended", lockOnEdit: true },
      { name: "notes", label: "Notes", type: "textarea", lockOnEdit: true }
    ]
  },

  offers: {
    label: "Offers & Bonuses",
    section: "Content",
    idField: "id",
    supportsCreate: true,
    supportsDelete: false,
    listColumns: [
      { key: "internal_name", label: "Name" },
      { key: "casino_id", label: "Casino ID" },
      { key: "offer_type", label: "Type" },
      { key: "status", label: "Status" },
      { key: "priority", label: "Priority" }
    ],
    fields: [
      // Verified: updateOffer's SET clause does not include
      // casino_id -- an offer cannot be moved to a different casino
      // after creation.
      { name: "casino_id", label: "Casino", type: "resource_select", required: true, lockOnEdit: true, optionsResource: "casinos", optionValueKey: "id", optionLabelKey: "name" },
      { name: "program_id", label: "Affiliate program (optional)", type: "resource_select", optionsResource: "affiliate-programs", optionValueKey: "id", optionLabelKey: "name" },
      { name: "offer_type", label: "Offer type", type: "select", required: true, options: ["welcome", "deposit", "no_deposit", "free_spins", "cashback", "reload", "vip", "tournament", "custom"] },
      { name: "internal_name", label: "Internal name", type: "text", required: true },
      { name: "public_headline", label: "Public headline", type: "text", hint: "required before the offer can be set to active" },
      { name: "public_description", label: "Public description", type: "textarea" },
      { name: "bonus_amount", label: "Bonus amount", type: "number", step: "0.01" },
      { name: "bonus_percent", label: "Bonus percent", type: "number", step: "0.01" },
      { name: "currency", label: "Currency", type: "text" },
      { name: "free_spins_qty", label: "Free spins quantity", type: "number" },
      { name: "min_deposit", label: "Minimum deposit", type: "number", step: "0.01" },
      { name: "max_bonus", label: "Maximum bonus", type: "number", step: "0.01" },
      { name: "wagering_multiplier", label: "Wagering multiplier", type: "number", step: "0.1" },
      { name: "max_bet", label: "Max bet while wagering", type: "number", step: "0.01" },
      { name: "eligible_games", label: "Eligible games", type: "text" },
      { name: "terms_and_conditions", label: "Terms & conditions", type: "textarea" },
      { name: "start_date", label: "Start date", type: "text", hint: "ISO date, optional" },
      { name: "expiry_date", label: "Expiry date", type: "text", hint: "ISO date, optional" },
      { name: "status", label: "Status", type: "select", options: ["draft", "scheduled", "active", "expired", "disabled"], hint: "transitions are validated -- e.g. active can only go to expired/disabled, never back to draft" },
      { name: "priority", label: "Priority", type: "number", hint: "higher wins when multiple active offers qualify" },
      { name: "allowed_geos", label: "Allowed GEOs", type: "list", hint: "one ISO country code per line, blank = no extra restriction" },
      { name: "blocked_geos", label: "Blocked GEOs", type: "list", hint: "one ISO country code per line" }
    ]
  },

  "tracking-links": {
    label: "Tracking Links",
    section: "Content",
    idField: "id",
    supportsCreate: true,
    supportsDelete: false,
    listColumns: [
      { key: "internal_name", label: "Name" },
      { key: "tracking_code", label: "Code" },
      { key: "casino_id", label: "Casino ID" },
      { key: "status", label: "Status" },
      { key: "health_status", label: "Health" }
    ],
    fields: [
      { name: "internal_name", label: "Internal name", type: "text", required: true },
      { name: "tracking_code", label: "Tracking code", type: "text", hint: "leave blank on create to auto-generate; must be unique and cannot match any casino's slug" },
      { name: "destination_url", label: "Destination URL", type: "text", required: true, hint: "must be https:// and cannot point back at this site's own domain" },
      { name: "casino_id", label: "Casino (optional)", type: "resource_select", optionsResource: "casinos", optionValueKey: "id", optionLabelKey: "name" },
      { name: "partner_id", label: "Affiliate partner (optional)", type: "resource_select", optionsResource: "affiliate-partners", optionValueKey: "id", optionLabelKey: "name" },
      { name: "program_id", label: "Affiliate program (optional)", type: "resource_select", optionsResource: "affiliate-programs", optionValueKey: "id", optionLabelKey: "name" },
      { name: "offer_id", label: "Offer (optional)", type: "resource_select", optionsResource: "offers", optionValueKey: "id", optionLabelKey: "internal_name" },
      { name: "campaign", label: "Campaign", type: "text" },
      { name: "source", label: "Source", type: "text" },
      { name: "medium", label: "Medium", type: "text" },
      { name: "content", label: "Content", type: "text" },
      { name: "allowed_geos", label: "Allowed GEOs", type: "list", hint: "one ISO country code per line, blank = no extra restriction" },
      { name: "blocked_geos", label: "Blocked GEOs", type: "list", hint: "one ISO country code per line" },
      { name: "priority", label: "Priority", type: "number" },
      { name: "status", label: "Status", type: "select", options: ["active", "disabled", "archived"] },
      // Not a real column on tracking_links -- the tenant's Super API
      // (handleGetTrackingLink/handleCreateTrackingLink/handleUpdateTrackingLink)
      // reads/writes these through tracking_link_geo_destinations,
      // same virtual-field pattern as casinos.geo_rules above.
      { name: "geo_destinations", label: "GEO destination overrides", type: "geo_destinations", optionsResource: "countries", optionValueKey: "code", optionLabelKey: "name", hint: "send a different destination URL to specific countries instead of the default above" }
    ]
  },

  // =====================================================
  // Campaigns (v9). Verified against
  // en/worker/database/campaigns.js's createCampaign/updateCampaign --
  // unlike every resource above, the Super API handler passes the
  // parsed body straight through to these functions, which destructure
  // camelCase keys (utmSource, not utm_source) -- field `name` values
  // below match that wire format exactly, not the DB's own column
  // names. Full CRUD except delete: no DELETE route exists on the
  // Super API for campaigns (handlers-reporting.js), same
  // no-delete convention as offers/tracking-links above.
  // =====================================================
  campaigns: {
    label: "Campaigns",
    section: "Content",
    idField: "id",
    supportsCreate: true,
    supportsDelete: false,
    listColumns: [
      { key: "name", label: "Name" },
      { key: "utm_campaign", label: "UTM campaign" },
      { key: "status", label: "Status" },
      { key: "start_date", label: "Start" },
      { key: "end_date", label: "End" }
    ],
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "utmSource", label: "UTM source", type: "text" },
      { name: "utmMedium", label: "UTM medium", type: "text" },
      { name: "utmCampaign", label: "UTM campaign", type: "text" },
      { name: "utmTerm", label: "UTM term", type: "text" },
      { name: "utmContent", label: "UTM content", type: "text" },
      { name: "status", label: "Status", type: "select", options: ["active", "paused", "ended", "archived"] },
      { name: "startDate", label: "Start date", type: "text", hint: "ISO date, optional" },
      { name: "endDate", label: "End date", type: "text", hint: "ISO date, optional" },
      { name: "notes", label: "Notes", type: "textarea" }
    ]
  },

  // =====================================================
  // Payment Methods. Verified against en/worker/database/
  // payment-methods.js's createPaymentMethod/updatePaymentMethod
  // (snake_case body keys, same as categories) and the Super API
  // routes added alongside this control-plane change
  // (worker/super/router.js, "payment_methods" resource key). Slug-
  // keyed, same shape as categories/countries. Full CRUD.
  // =====================================================
  "payment-methods": {
    label: "Payment Methods",
    section: "Content",
    idField: "slug",
    supportsCreate: true,
    supportsDelete: true,
    listColumns: [
      { key: "name", label: "Name" },
      { key: "slug", label: "Slug" },
      { key: "method_type", label: "Type" },
      { key: "status", label: "Status" },
      { key: "sort_order", label: "Order" }
    ],
    fields: [
      { name: "slug", label: "Slug", type: "text", required: true, lockOnEdit: true },
      { name: "name", label: "Name", type: "text", required: true },
      { name: "method_type", label: "Type", type: "select", options: ["card", "ewallet", "crypto", "bank", "other"] },
      { name: "icon_url", label: "Icon URL", type: "text" },
      { name: "description", label: "Description", type: "textarea" },
      { name: "seo_title", label: "SEO title", type: "text" },
      { name: "seo_description", label: "SEO description", type: "textarea" },
      { name: "seo_keywords", label: "SEO keywords", type: "text" },
      { name: "sort_order", label: "Sort order", type: "number" },
      { name: "status", label: "Status", type: "select", options: ["published", "draft"] },
      { name: "published", label: "Published", type: "checkbox" }
    ]
  }
};

export function getResourceConfig(key) {
  return RESOURCES[key] || null;
}
