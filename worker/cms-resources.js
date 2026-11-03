// =====================================================
// LUMMET CMS RESOURCE CONTRACT
//
// Drives the generic /cms/:resource screens in
// views/pages/cms.js. Unlike resources.js (which proxies
// a tenant's Super API over HTTPS), every one of these
// reads/writes this control plane's OWN D1 directly via
// cms.js — there is no remote call involved.
//
// Field types understood by cms.js's form renderer:
//   text / textarea   plain string, or null if empty
//   richtext           HTML string via the same rich text
//                       editor used by the tenant CRUD screens
//   select             one of `options`
//   number             real number, or null if empty
//   resource_select    numeric id, options pulled from another
//                       CMS resource (e.g. author_id -> authors)
//   tenant_select       numeric/text id, options pulled from the
//                       tenant registry (brands.tenant_id)
// =====================================================

export const CMS_RESOURCES = {
  pages: {
    label: "Pages",
    table: "lummet_pages",
    listColumns: [
      { key: "title", label: "Title" },
      { key: "slug", label: "Slug" },
      { key: "status", label: "Status" }
    ],
    orderBy: "title",
    fields: [
      { name: "slug", label: "Slug", type: "text", required: true, hint: "lummet.com/p/<slug>; about, security, privacy and terms are served at /<slug>" },
      { name: "title", label: "Title", type: "text", required: true },
      { name: "excerpt", label: "Excerpt", type: "textarea" },
      { name: "content", label: "Content", type: "richtext" },
      { name: "author_id", label: "Author", type: "resource_select", optionsResource: "authors" },
      { name: "status", label: "Status", type: "select", options: ["draft", "published"] },
      { name: "seo_title", label: "SEO title", type: "text" },
      { name: "seo_description", label: "SEO description", type: "textarea" },
      { name: "og_image", label: "Social share image URL", type: "text", hint: "1200x630 recommended" }
    ]
  },

  authors: {
    label: "Authors",
    table: "lummet_authors",
    listColumns: [
      { key: "name", label: "Name" },
      { key: "slug", label: "Slug" },
      { key: "title", label: "Title" }
    ],
    orderBy: "name",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "slug", label: "Slug", type: "text", required: true },
      { name: "title", label: "Title", type: "text", hint: "e.g. Editor, Head of Partnerships" },
      { name: "bio", label: "Bio", type: "textarea" },
      { name: "avatar_url", label: "Avatar URL", type: "text" },
      { name: "social_links", label: "Social links (raw JSON)", type: "textarea", hint: '{"twitter":"https://..."}' }
    ]
  },

  brands: {
    label: "Brand profiles",
    table: "lummet_brands",
    listColumns: [
      { key: "name", label: "Name" },
      { key: "slug", label: "Slug" },
      { key: "status", label: "Status" }
    ],
    orderBy: "sort_order, name",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "slug", label: "Slug", type: "text", required: true },
      { name: "category", label: "Category", type: "text", hint: "e.g. iGaming & Casino Intelligence. Used for the filter on /brands" },
      { name: "tagline", label: "Tagline", type: "text" },
      { name: "description", label: "Description", type: "richtext" },
      { name: "logo_url", label: "Logo URL", type: "text" },
      { name: "website_url", label: "Website URL", type: "text" },
      { name: "tenant_id", label: "Linked tenant (optional)", type: "tenant_select" },
      { name: "status", label: "Status", type: "select", options: ["draft", "published"] },
      { name: "sort_order", label: "Sort order", type: "number", default: 0 },
      { name: "seo_title", label: "SEO title", type: "text" },
      { name: "seo_description", label: "SEO description", type: "textarea" },
      { name: "og_image", label: "Social share image URL", type: "text", hint: "1200x630 recommended" }
    ]
  },

  partners: {
    label: "Partners",
    table: "lummet_partners",
    listColumns: [
      { key: "name", label: "Name" },
      { key: "partner_type", label: "Type" },
      { key: "status", label: "Status" }
    ],
    orderBy: "sort_order, name",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "slug", label: "Slug", type: "text", required: true },
      { name: "partner_type", label: "Type", type: "select", options: ["technology", "payments", "affiliate", "media", "other"] },
      { name: "logo_url", label: "Logo URL", type: "text" },
      { name: "website_url", label: "Website URL", type: "text" },
      { name: "description", label: "Description", type: "textarea" },
      { name: "status", label: "Status", type: "select", options: ["draft", "published"] },
      { name: "sort_order", label: "Sort order", type: "number", default: 0 }
    ]
  },

  updates: {
    label: "Lummet updates",
    table: "lummet_updates",
    listColumns: [
      { key: "title", label: "Title" },
      { key: "status", label: "Status" },
      { key: "published_at", label: "Published at" }
    ],
    orderBy: "created_at DESC",
    fields: [
      { name: "slug", label: "Slug", type: "text", required: true },
      { name: "title", label: "Title", type: "text", required: true },
      { name: "excerpt", label: "Excerpt", type: "textarea" },
      { name: "content", label: "Content", type: "richtext" },
      { name: "author_id", label: "Author", type: "resource_select", optionsResource: "authors" },
      { name: "featured_image", label: "Featured image URL", type: "text" },
      { name: "status", label: "Status", type: "select", options: ["draft", "published"] },
      { name: "published_at", label: "Published at", type: "text", hint: "ISO date, optional" },
      { name: "seo_title", label: "SEO title", type: "text" },
      { name: "seo_description", label: "SEO description", type: "textarea" },
      { name: "og_image", label: "Social share image URL", type: "text", hint: "1200x630 recommended" }
    ]
  },

  publications: {
    label: "Publications",
    table: "lummet_publications",
    listColumns: [
      { key: "title", label: "Title" },
      { key: "publication_type", label: "Type" },
      { key: "status", label: "Status" }
    ],
    orderBy: "created_at DESC",
    fields: [
      { name: "slug", label: "Slug", type: "text", required: true },
      { name: "title", label: "Title", type: "text", required: true },
      { name: "publication_type", label: "Type", type: "select", options: ["blog", "press", "report"] },
      { name: "excerpt", label: "Excerpt", type: "textarea" },
      { name: "content", label: "Content", type: "richtext" },
      { name: "source_name", label: "Source name", type: "text", hint: "if this is a press mention" },
      { name: "source_url", label: "Source URL", type: "text" },
      { name: "author_id", label: "Author", type: "resource_select", optionsResource: "authors" },
      { name: "featured_image", label: "Featured image URL", type: "text" },
      { name: "status", label: "Status", type: "select", options: ["draft", "published"] },
      { name: "published_at", label: "Published at", type: "text", hint: "ISO date, optional" },
      { name: "seo_title", label: "SEO title", type: "text" },
      { name: "seo_description", label: "SEO description", type: "textarea" },
      { name: "og_image", label: "Social share image URL", type: "text", hint: "1200x630 recommended" }
    ]
  },

  advertisements: {
    label: "Advertisements",
    table: "lummet_advertisements",
    listColumns: [
      { key: "name", label: "Name" },
      { key: "placement", label: "Placement" },
      { key: "status", label: "Status" }
    ],
    orderBy: "sort_order, name",
    fields: [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "placement", label: "Placement", type: "select", options: ["homepage_hero", "homepage_banner", "homepage_sidebar", "homepage_footer"] },
      { name: "image_url", label: "Image URL", type: "text" },
      { name: "link_url", label: "Link URL", type: "text" },
      { name: "alt_text", label: "Alt text", type: "text" },
      { name: "status", label: "Status", type: "select", options: ["draft", "active", "paused"] },
      { name: "start_date", label: "Start date", type: "text", hint: "ISO date, optional" },
      { name: "end_date", label: "End date", type: "text", hint: "ISO date, optional" },
      { name: "sort_order", label: "Sort order", type: "number", default: 0 }
    ]
  },

  homepage_sections: {
    label: "Homepage sections",
    table: "lummet_homepage_sections",
    listColumns: [
      { key: "title", label: "Title" },
      { key: "layout", label: "Layout" },
      { key: "status", label: "Status" }
    ],
    orderBy: "sort_order, title",
    fields: [
      { name: "section_key", label: "Section key", type: "text", required: true, hint: "Anchor id, e.g. brands -> /#brands. Lowercase letters, numbers, dashes" },
      { name: "kind", label: "Kind", type: "select", options: ["text", "features", "steps", "checklist", "panel", "brands", "stats", "updates", "insights", "partners", "faq", "cta", "contact"], hint: "Which component renders this section. Data-driven kinds (brands, updates, insights, partners, stats) hide themselves when there is nothing published" },
      { name: "feature_group", label: "Feature group", type: "text", hint: "For features / steps / checklist / panel: which Features group to show. For faq: which FAQ group" },
      { name: "background", label: "Background", type: "select", options: ["default", "soft", "dark"] },
      { name: "title", label: "Title", type: "text", required: true },
      { name: "subtitle", label: "Subtitle / eyebrow", type: "text" },
      { name: "body", label: "Body", type: "richtext" },
      { name: "image_url", label: "Image URL", type: "text", hint: "used when layout is image_left or image_right" },
      { name: "layout", label: "Layout", type: "select", options: ["text_only", "image_left", "image_right"] },
      { name: "cta_label", label: "Button label", type: "text" },
      { name: "cta_href", label: "Button link", type: "text" },
      { name: "status", label: "Status", type: "select", options: ["draft", "published"] },
      { name: "sort_order", label: "Sort order", type: "number", hint: "lower shows first" }
    ]
  },
  features: {
    label: "Features",
    table: "lummet_features",
    listColumns: [
      { key: "title", label: "Title" },
      { key: "group_key", label: "Group" },
      { key: "status", label: "Status" }
    ],
    orderBy: "group_key, sort_order, title",
    fields: [
      { name: "feature_key", label: "Key", type: "text", required: true, hint: "Unique, e.g. cap-monitoring" },
      { name: "group_key", label: "Group", type: "text", required: true, hint: "platform, how_it_works, capabilities, why, ai, or your own; referenced by a homepage section's Feature group" },
      { name: "icon", label: "Icon", type: "select", options: ["", "check", "plug", "sliders", "trending", "layers", "sparkles", "file-text", "search", "map-pin", "share", "activity", "eye", "message", "lock", "shield", "key", "database", "globe", "cpu", "zap", "clock", "users"] },
      { name: "title", label: "Title", type: "text", required: true },
      { name: "body", label: "Body", type: "textarea" },
      { name: "status", label: "Status", type: "select", options: ["draft", "published"] },
      { name: "sort_order", label: "Sort order", type: "number", default: 0 }
    ]
  },

  nav_links: {
    label: "Navigation links",
    table: "lummet_nav_links",
    listColumns: [
      { key: "label", label: "Label" },
      { key: "placement", label: "Placement" },
      { key: "status", label: "Status" }
    ],
    orderBy: "placement, sort_order, label",
    fields: [
      { name: "placement", label: "Placement", type: "select", options: ["header", "header_cta", "footer_platform", "footer_company", "footer_legal"], required: true },
      { name: "label", label: "Label", type: "text", required: true },
      { name: "href", label: "Link", type: "text", required: true, hint: "/brands, /#faq, https://..., mailto:..." },
      { name: "visible_when", label: "Show when", type: "select", options: ["always", "has_brands", "has_updates", "has_publications", "has_partners", "has_faq", "has_contact"], hint: "Hides the link until its destination has published content. For a page link use always and only publish the page" },
      { name: "status", label: "Status", type: "select", options: ["draft", "published"] },
      { name: "sort_order", label: "Sort order", type: "number", default: 0 }
    ]
  },

  faqs: {
    label: "FAQs",
    table: "lummet_faqs",
    listColumns: [
      { key: "question", label: "Question" },
      { key: "group_key", label: "Group" },
      { key: "status", label: "Status" }
    ],
    orderBy: "group_key, sort_order, id",
    fields: [
      { name: "group_key", label: "Group", type: "text", required: true, hint: "general" },
      { name: "question", label: "Question", type: "text", required: true },
      { name: "answer", label: "Answer", type: "richtext", required: true },
      { name: "status", label: "Status", type: "select", options: ["draft", "published"] },
      { name: "sort_order", label: "Sort order", type: "number", default: 0 }
    ]
  },

  forms: {
    label: "Forms",
    table: "lummet_forms",
    listColumns: [
      { key: "form_key", label: "Key" },
      { key: "title", label: "Title" },
      { key: "status", label: "Status" }
    ],
    orderBy: "form_key",
    fields: [
      { name: "form_key", label: "Key", type: "text", required: true, hint: "contact -> /contact, demo -> /demo, anything else -> /forms/<key>" },
      { name: "eyebrow", label: "Eyebrow", type: "text" },
      { name: "title", label: "Title", type: "text", required: true },
      { name: "intro", label: "Intro", type: "richtext" },
      { name: "submit_label", label: "Button label", type: "text", required: true },
      { name: "success_title", label: "Success title", type: "text", required: true },
      { name: "success_message", label: "Success message", type: "richtext", required: true },
      { name: "side_title", label: "Side panel title", type: "text", hint: "Leave side title and body empty to hide the side panel" },
      { name: "side_body", label: "Side panel body", type: "richtext" },
      { name: "status", label: "Status", type: "select", options: ["draft", "published"] },
      { name: "seo_title", label: "SEO title", type: "text" },
      { name: "seo_description", label: "SEO description", type: "textarea" },
      { name: "og_image", label: "Social share image URL", type: "text" }
    ]
  },

  form_fields: {
    label: "Form fields",
    table: "lummet_form_fields",
    listColumns: [
      { key: "form_key", label: "Form" },
      { key: "label", label: "Label" },
      { key: "type", label: "Type" },
      { key: "required", label: "Required" },
      { key: "status", label: "Status" }
    ],
    orderBy: "form_key, sort_order, id",
    fields: [
      { name: "form_key", label: "Form key", type: "text", required: true },
      { name: "field_key", label: "Field key", type: "text", required: true, hint: "Letters, numbers and underscores. name, email and message get special treatment in the Inquiries list" },
      { name: "label", label: "Label", type: "text", required: true },
      { name: "type", label: "Type", type: "select", options: ["text", "email", "tel", "url", "textarea", "select"] },
      { name: "required", label: "Required (1 = yes, 0 = no)", type: "number", default: 0 },
      { name: "placeholder", label: "Placeholder", type: "text" },
      { name: "help_text", label: "Help text", type: "text" },
      { name: "options", label: "Options (select only, one per line)", type: "textarea" },
      { name: "max_length", label: "Max length", type: "number", default: 2000 },
      { name: "status", label: "Status", type: "select", options: ["draft", "published"] },
      { name: "sort_order", label: "Sort order", type: "number", default: 0 }
    ]
  },

  inquiries: {
    label: "Inquiries",
    table: "lummet_inquiries",
    supportsCreate: false,
    listColumns: [
      { key: "created_at", label: "Received (UTC)" },
      { key: "form_key", label: "Form" },
      { key: "name", label: "Name" },
      { key: "email", label: "Email" },
      { key: "summary", label: "Summary" },
      { key: "status", label: "Status" }
    ],
    orderBy: "id DESC",
    fields: [
      { name: "created_at", label: "Received (UTC)", type: "text", readOnly: true },
      { name: "form_key", label: "Form", type: "text", readOnly: true },
      { name: "name", label: "Name", type: "text", readOnly: true },
      { name: "email", label: "Email", type: "text", readOnly: true },
      { name: "details", label: "Submission", type: "textarea", readOnly: true },
      { name: "status", label: "Status", type: "select", options: ["new", "read", "replied", "spam", "archived"] },
      { name: "admin_notes", label: "Internal notes (never shown publicly)", type: "textarea" }
    ]
  },

  ui_strings: {
    label: "Interface text",
    table: "lummet_ui_strings",
    listColumns: [
      { key: "group_key", label: "Group" },
      { key: "ui_key", label: "Key" },
      { key: "value", label: "Text" }
    ],
    orderBy: "group_key, ui_key",
    fields: [
      { name: "ui_key", label: "Key", type: "text", required: true, hint: "Referenced by the site templates. Renaming a seeded key blanks that label" },
      { name: "value", label: "Text", type: "textarea", required: true },
      { name: "group_key", label: "Group", type: "text" }
    ]
  }
};

export function getCmsResourceConfig(key) {
  return CMS_RESOURCES[key] || null;
}
