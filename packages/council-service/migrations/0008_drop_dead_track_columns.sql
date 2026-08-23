-- Nothing ever wrote either of these columns. Speaker attribution is not persisted: the pipeline
-- reads the provider id out of the track file name and binds it to a participant in memory while it
-- renders the transcript, and it puts a track on the meeting clock from the timestamp in the same
-- file name. So `participant_id` stayed null on every row and `start_offset_ms` appears nowhere in
-- the service source at all.
--
-- Their comments described writes that never happen, which sends the next maintainer looking for a
-- broken mapping to repair. Drop the columns instead of correcting the comments: an empty column is
-- a claim that the data exists somewhere. Neither is indexed, in a CHECK, or part of the table's
-- UNIQUE key, so SQLite drops them in place.
ALTER TABLE meeting_tracks DROP COLUMN participant_id;
ALTER TABLE meeting_tracks DROP COLUMN start_offset_ms;
