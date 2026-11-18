-- Merging two things (a re-paired valve, a device found twice) gives the survivor the points of the dropped one: a point the survivor already
-- has takes over the dropped point's feeds, and the dropped point says where its feeds went. Facts are never moved; their series are.
ALTER TABLE point ADD COLUMN merged_into bigint REFERENCES point (id) DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX point_merged_into ON point (merged_into) WHERE merged_into IS NOT NULL;
