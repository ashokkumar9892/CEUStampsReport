-- Run as tradealgoadmin, connected to **ceustampsdb**, after 01-master-create-login.sql.
-- Read-only, column-level grants (docs/report-requirements.md §2.1).

CREATE USER [ceustamps_report] FOR LOGIN [ceustamps_report];

-- Whole tables that carry nothing sensitive beyond what the report shows.
GRANT SELECT ON OBJECT::dbo.sign_ins            TO [ceustamps_report];
GRANT SELECT ON OBJECT::dbo.section_completions TO [ceustamps_report];
GRANT SELECT ON OBJECT::dbo.certificates        TO [ceustamps_report];

-- courses: every column EXCEPT body. body holds the full question pool,
-- including the correct answers.
GRANT SELECT ON OBJECT::dbo.courses
  (id, state_code, title, published_at, program_id, program_title, section_number, section_count)
  TO [ceustamps_report];

-- sessions: every column EXCEPT token_hash. token_hash identifies live
-- student sessions and has no place in a report.
GRANT SELECT ON OBJECT::dbo.sessions
  (id, voucher_code, course_id, state_code, first_name, last_name, license_number,
   email, phone, started_at, completed_at, module_index, credited_seconds,
   first_try_perfect, is_demo, created_ip, user_agent,
   created_city, created_region, created_country)
  TO [ceustamps_report];

-- Sanity check: both of these must fail with "The SELECT permission was denied".
--   SELECT TOP 1 token_hash FROM dbo.sessions;
--   SELECT TOP 1 body FROM dbo.courses;
