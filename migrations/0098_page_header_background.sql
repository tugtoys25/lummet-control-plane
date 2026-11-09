-- 0098: per-page header band colour (default = follow the site setting "Page header band")
ALTER TABLE lummet_pages ADD COLUMN header_background TEXT NOT NULL DEFAULT 'default';
