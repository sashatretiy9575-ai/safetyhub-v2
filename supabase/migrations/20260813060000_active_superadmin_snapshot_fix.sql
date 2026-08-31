-- The invariant assertion runs from an AFTER trigger and must observe the row
-- just changed by the current statement.  VOLATILE gives it a fresh command
-- snapshot; STABLE could see the statement-start snapshot and miss the loss of
-- the last active superadmin.
alter function private.assert_active_superadmin_invariant() volatile;

