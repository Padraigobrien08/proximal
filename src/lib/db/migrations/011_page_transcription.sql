-- Pages with no extractable text can be transcribed from a rendered image by the live model. The extracted_text
-- column then holds the transcription, and this records which model produced it, so the source view can label it.
ALTER TABLE source_pages ADD COLUMN transcribed_by TEXT;
