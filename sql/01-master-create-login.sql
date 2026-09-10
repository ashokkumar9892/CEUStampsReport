-- Run as tradealgoadmin, connected to the **master** database
-- (Azure SQL cannot switch databases with USE). See docs/report-requirements.md §2.1.
--
-- Choose a new strong password here and put the same value in the report app's
-- .env (REPORT_SQL_PASSWORD) or its hosting secret store — never commit it.

CREATE LOGIN [ceustamps_report] WITH PASSWORD = '<choose a new strong password>';
