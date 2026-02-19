USE comms;

ALTER TABLE notes
  MODIFY COLUMN note_type ENUM('admin_note','clinical_note','complaint_note') NOT NULL;
