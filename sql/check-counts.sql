-- Headline numbers computed straight from the database (docs/report-requirements.md §8).
-- Compare with the People / Sittings / Sign-ins tiles for the same range.
--
-- Set the window as the page does (§5.1): local midnight starting the From day,
-- to local midnight starting the day after the To day, both converted to UTC.
-- The app prints the exact window it used in the status line under the filters.

DECLARE @from DATETIME2(3) = '2026-09-01T00:00:00';
DECLARE @to   DATETIME2(3) = '2026-09-11T00:00:00';

-- Sittings (demo excluded)
SELECT COUNT(*) AS sittings FROM dbo.sessions
WHERE started_at >= @from AND started_at < @to AND is_demo = 0;

-- Sign-ins
SELECT COUNT(*) AS sign_ins FROM dbo.sign_ins
WHERE at >= @from AND at < @to;

-- People
SELECT COUNT(DISTINCT UPPER(TRIM(license_number))) AS people FROM (
  SELECT license_number FROM dbo.sessions
    WHERE started_at >= @from AND started_at < @to AND is_demo = 0
  UNION ALL
  SELECT license_number FROM dbo.sign_ins
    WHERE at >= @from AND at < @to
) AS seen;

-- Reference, 10 Sep 2026, for the window above: 8 people, 7 sittings, 4 sign-ins.
