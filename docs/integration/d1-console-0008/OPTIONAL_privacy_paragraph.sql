UPDATE lummet_pages
SET content = content || '<h2>Contact and demo forms</h2><p>If you use the contact or demo form on this site, we store the details you enter (for example your name, email address, company and message) together with a one-way hash of your IP address, which is used only to limit repeated submissions. We use these details to respond to your request.</p>',
    updated_at = CURRENT_TIMESTAMP
WHERE slug = 'privacy' AND content NOT LIKE '%Contact and demo forms%';
