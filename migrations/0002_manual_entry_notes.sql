-- Lecturer notes on each check-in, and whether the lecturer added it by hand.
-- Additive only: existing rows get an empty note and are marked as scanned.
ALTER TABLE records ADD COLUMN notes TEXT NOT NULL DEFAULT '';
ALTER TABLE records ADD COLUMN manual INTEGER NOT NULL DEFAULT 0;
