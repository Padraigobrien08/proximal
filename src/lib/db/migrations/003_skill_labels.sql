-- Short display copy; the full objective stays the source of truth on the topic page.
ALTER TABLE skills ADD COLUMN label TEXT;
ALTER TABLE skills ADD COLUMN summary TEXT;
