-- Lot 7b: the admin's "test this login" result, per saved login. Reset when the login is saved again.
ALTER TABLE logins ADD COLUMN last_tested_at INTEGER;  -- ms epoch
ALTER TABLE logins ADD COLUMN last_result TEXT;        -- 'ok' | 'fail'
