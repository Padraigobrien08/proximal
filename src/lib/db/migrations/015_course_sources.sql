-- Persistent course model, phase A: a course can hold several sources, and every citation names its source.
-- Sources get a role: 'lecture' (teaching material, citable) or 'course_document' (syllabus/descriptor; never cited).
ALTER TABLE sources ADD COLUMN role TEXT NOT NULL DEFAULT 'lecture' CHECK (role IN ('lecture', 'course_document'));

-- Citations {page} become {sourceId, page}. Every existing course has exactly one source, so the course's oldest source is
-- the one each citation meant. Frozen session snapshots are historical and are left as recorded; readers resolve a
-- citation without a sourceId to the course's oldest source.
UPDATE units
SET source_refs_json = (
  SELECT json_group_array(json_object(
    'sourceId', (SELECT s.id FROM sources s JOIN topics t ON t.course_id = s.course_id WHERE t.id = units.topic_id ORDER BY s.created_at, s.rowid LIMIT 1),
    'page', json_extract(r.value, '$.page')))
  FROM json_each(units.source_refs_json) r
)
WHERE source_refs_json <> '[]'
  AND EXISTS (SELECT 1 FROM sources s JOIN topics t ON t.course_id = s.course_id WHERE t.id = units.topic_id);

UPDATE questions
SET source_refs_json = (
  SELECT json_group_array(json_object(
    'sourceId', (
      SELECT s.id FROM sources s
      JOIN topics t ON t.course_id = s.course_id
      JOIN units u ON u.topic_id = t.id
      JOIN skills k ON k.unit_id = u.id
      WHERE k.id = questions.skill_id
      ORDER BY s.created_at, s.rowid LIMIT 1),
    'page', json_extract(r.value, '$.page')))
  FROM json_each(questions.source_refs_json) r
)
WHERE source_refs_json <> '[]'
  AND EXISTS (
    SELECT 1 FROM sources s
    JOIN topics t ON t.course_id = s.course_id
    JOIN units u ON u.topic_id = t.id
    JOIN skills k ON k.unit_id = u.id
    WHERE k.id = questions.skill_id);
