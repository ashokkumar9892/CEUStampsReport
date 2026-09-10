// Rows shaped like the two report queries return them (§4), covering the cases in §5.

const at = (s) => new Date(`2026-09-${s}Z`);

function session(overrides) {
  return {
    session_id: overrides.session_id,
    first_name: 'Test', last_name: 'Student', license_number: 'X-1', email: null, phone: null,
    state_code: 'NC', course_id: 'nc-elec-4h-s1', voucher_code: 'V-1',
    started_at: at('02T14:00:00'), completed_at: null, credited_seconds: 0, module_index: 0, is_demo: false,
    created_ip: null, created_city: null, created_region: null, created_country: null, user_agent: 'Mozilla/5.0',
    course_title: 'Section 1', program_id: null, program_title: null, section_number: null, section_count: null,
    passed: null, score_percent: null, seat_seconds: null, certificate_number: null,
    ...overrides,
  };
}

const concord = { created_city: 'Concord', created_region: 'North Carolina', created_country: 'United States' };
const ncProgram = { program_id: 'nc-elec-4h', program_title: 'NC Electrical 4h', section_count: 8 };

export const sessionRows = [
  // Pat: two sections of a programme, from the same office; old row carries a port.
  session({
    session_id: 'S1', first_name: 'Pat', last_name: 'Rivera', license_number: 'nc-12345 ', email: 'pat@old.example',
    phone: '+1 704 555 0100', started_at: at('02T14:00:00'), completed_at: at('02T14:40:00'), credited_seconds: 2400,
    created_ip: '98.122.179.148:61347', ...concord, ...ncProgram, course_id: 'nc-elec-4h-s1', section_number: 1,
    passed: true, score_percent: 90, seat_seconds: 1800,
  }),
  session({
    session_id: 'S2', first_name: 'Pat', last_name: 'Rivera', license_number: 'NC-12345', email: 'pat@new.example',
    started_at: at('03T15:00:00'), credited_seconds: 750,
    created_ip: '98.122.179.148', ...concord, ...ncProgram, course_id: 'nc-elec-4h-s2', section_number: 2,
  }),
  // Jordan: a single-sitting course, finished with a certificate, browsing on the API machine.
  session({
    session_id: 'S3', first_name: 'Jordan', last_name: 'Lee', license_number: 'SC-777', state_code: 'SC',
    course_id: 'sc-plumb', course_title: 'SC Plumbing Code Update', started_at: at('04T09:00:00'),
    completed_at: at('04T10:00:00'), credited_seconds: 3600, certificate_number: 'CEU-2026-0001', created_ip: '::1',
  }),
  // Sam: failed a section from a private network.
  session({
    session_id: 'S4', first_name: 'Sam', last_name: 'Okafor', license_number: 'GA-55', state_code: 'GA',
    ...ncProgram, course_id: 'nc-elec-4h-s3', section_number: 3, started_at: at('05T11:00:00'),
    completed_at: at('05T11:30:00'), passed: false, score_percent: 60, seat_seconds: 1500, created_ip: '10.0.0.5',
  }),
  // A course with no courses row left: label falls back to the raw id.
  session({
    session_id: 'S5', first_name: 'Ava', last_name: 'Kim', license_number: 'FL-1', state_code: 'FL',
    course_id: 'legacy-course', course_title: null, started_at: at('06T08:00:00'), completed_at: at('06T09:00:00'),
    credited_seconds: 3570, created_ip: '203.0.113.50',
  }),
  // No IP recorded at all.
  session({
    session_id: 'S6', first_name: 'Vic', last_name: 'Ng', license_number: 'VA-2', state_code: 'VA',
    course_id: 'va-safety', course_title: 'VA Safety Refresher', started_at: at('07T08:00:00'),
  }),
  // A demo sitting: hidden unless asked for.
  session({ session_id: 'S7', first_name: 'Demo', last_name: 'User', license_number: 'DEMO-1', is_demo: true, started_at: at('08T08:00:00') }),
];

function signIn(overrides) {
  return {
    id: overrides.id, at: at('01T12:00:00'), license_number: 'X-1', state_code: null, first_name: null, last_name: null,
    email: null, phone: null, created_ip: null, created_city: null, created_region: null, created_country: null,
    user_agent: 'Mozilla/5.0', ...overrides,
  };
}

export const signInRows = [
  signIn({ id: 'G1', at: at('01T12:00:00'), license_number: 'nc-12345', first_name: 'Patricia', last_name: 'R', created_ip: '98.122.179.148', ...concord }),
  // TX-9 never enrolls: first visit gives no name, only an email; a later one gives a name.
  signIn({ id: 'G2', at: at('02T10:00:00'), license_number: 'TX-9', email: 'chris@example.com', created_ip: '198.51.100.9' }),
  signIn({ id: 'G3', at: at('09T10:00:00'), license_number: ' tx-9', first_name: 'Chris', last_name: 'Doe', email: 'other@example.com', state_code: 'TX', created_ip: '198.51.100.9' }),
  signIn({ id: 'G4', at: at('04T08:55:00'), license_number: 'SC-777', first_name: 'Jordan', last_name: 'Lee', created_ip: '::1' }),
];
