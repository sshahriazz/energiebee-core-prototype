-- The raw-file check tables were the only foreign keys that were not deferrable, so loading a database table by table (the demo copy, a fixture)
-- failed as soon as the live database had a check row: the check table loaded before the home it names. Every foreign key now defers like the rest.
ALTER TABLE raw_payload_check ALTER CONSTRAINT raw_payload_check_site_id_fkey DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE raw_payload_check ALTER CONSTRAINT raw_payload_check_payload_id_fkey DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE raw_check_run ALTER CONSTRAINT raw_check_run_site_id_fkey DEFERRABLE INITIALLY IMMEDIATE;
