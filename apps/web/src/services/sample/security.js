/**
 * ============================================================================
 *  SAMPLE DATA — FOR FRONTEND PREVIEW ONLY
 * ============================================================================
 * Illustrative users, login activity and audit entries so the security views
 * can be reviewed before the Flask API exists. NOT real accounts or events.
 * Emails use the reserved example.org domain; IP addresses come from the
 * RFC 5737 documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24).
 * No passwords, hashes or tokens exist here — and the UI never displays them.
 * ============================================================================
 */
const now = Date.now();
const minutesAgo = (m) => new Date(now - m * 60000).toISOString();

export const sampleUsers = [
  { id: 1, fullName: "Sample Admin", email: "admin@example.org", role: "admin", status: "active", farms: [], lastLoginAt: minutesAgo(12), createdAt: minutesAgo(60 * 24 * 200) },
  { id: 2, fullName: "Sample Manager 1", email: "manager1@example.org", role: "farm_manager", status: "active", farms: ["Sample Farm — Greenfield"], lastLoginAt: minutesAgo(95), createdAt: minutesAgo(60 * 24 * 150) },
  { id: 3, fullName: "Sample Manager 2", email: "manager2@example.org", role: "farm_manager", status: "active", farms: ["Sample Farm — Riverside"], lastLoginAt: minutesAgo(60 * 26), createdAt: minutesAgo(60 * 24 * 140) },
  { id: 4, fullName: "Sample Manager 3", email: "manager3@example.org", role: "farm_manager", status: "invited", farms: ["Sample Farm — Hilltop"], lastLoginAt: null, createdAt: minutesAgo(60 * 24 * 2) },
  { id: 5, fullName: "Sample Analyst", email: "analyst@example.org", role: "analyst", status: "active", farms: ["Sample Farm — Greenfield", "Sample Farm — Riverside"], lastLoginAt: minutesAgo(18), createdAt: minutesAgo(60 * 24 * 90) },
  { id: 6, fullName: "Sample Former Staff", email: "former@example.org", role: "analyst", status: "suspended", farms: [], lastLoginAt: minutesAgo(60 * 24 * 40), createdAt: minutesAgo(60 * 24 * 300) },
];

export const sampleLoginActivity = [
  { id: 1, userName: "Sample Admin", email: "admin@example.org", ip: "192.0.2.14", userAgent: "Firefox on Linux", at: minutesAgo(12) },
  { id: 2, userName: "Sample Analyst", email: "analyst@example.org", ip: "198.51.100.23", userAgent: "Chrome on Windows", at: minutesAgo(18) },
  { id: 3, userName: "Sample Manager 1", email: "manager1@example.org", ip: "203.0.113.7", userAgent: "Safari on iOS", at: minutesAgo(95) },
  { id: 4, userName: "Sample Manager 2", email: "manager2@example.org", ip: "203.0.113.42", userAgent: "Chrome on Android", at: minutesAgo(60 * 26) },
  { id: 5, userName: "Sample Admin", email: "admin@example.org", ip: "192.0.2.14", userAgent: "Firefox on Linux", at: minutesAgo(60 * 30) },
];

export const sampleFailedLogins = [
  { id: 1, email: "manager2@example.org", ip: "198.51.100.77", reason: "Incorrect password", attempts: 2, at: minutesAgo(48) },
  { id: 2, email: "unknown-user@example.org", ip: "203.0.113.200", reason: "Unknown account", attempts: 5, at: minutesAgo(60 * 5) },
  { id: 3, email: "former@example.org", ip: "192.0.2.99", reason: "Account suspended", attempts: 1, at: minutesAgo(60 * 50) },
];

const AUDIT_TEMPLATES = [
  ["Sample Admin", "user.invite", "User manager3@example.org", "success"],
  ["Sample Analyst", "dataset.upload", "Dataset sample_daily_readings.csv", "success"],
  ["Sample Admin", "farm.update", "Farm SMP-F03", "success"],
  ["Sample Analyst", "prediction.generate", "Batch SMP-B102", "success"],
  ["Sample Manager 2", "auth.login", "Session", "failure"],
  ["Sample Admin", "user.role_change", "User analyst@example.org", "success"],
  ["Sample Manager 1", "batch.create", "Batch SMP-B102", "success"],
  ["Sample Analyst", "report.export", "Mortality report (PDF)", "success"],
  ["Sample Manager 1", "user.list", "Users", "denied"],
  ["Sample Admin", "auth.login", "Session", "success"],
  ["Sample Manager 1", "reading.create", "Batch SMP-B101", "success"],
  ["Sample Admin", "user.suspend", "User former@example.org", "success"],
];
const IPS = ["192.0.2.14", "198.51.100.23", "203.0.113.7", "203.0.113.42", "198.51.100.77"];

export const sampleAuditEntries = Array.from({ length: 36 }, (_, i) => {
  const [actor, action, resource, outcome] = AUDIT_TEMPLATES[i % AUDIT_TEMPLATES.length];
  return { id: 1000 + i, timestamp: minutesAgo(14 + i * 173), actor, action, resource, ip: IPS[i % IPS.length], outcome };
});

export const sampleSecurityEvents = [
  { id: 1, type: "failed_login", severity: "warning", message: "2 failed sign-in attempts for manager2@example.org", ip: "198.51.100.77", at: minutesAgo(48) },
  { id: 2, type: "permission_denied", severity: "warning", message: "Farm manager attempted to open user management", ip: "203.0.113.7", at: minutesAgo(60 * 3) },
  { id: 3, type: "lockout", severity: "danger", message: "Temporary lockout after 5 failed attempts (unknown account)", ip: "203.0.113.200", at: minutesAgo(60 * 5) },
  { id: 4, type: "role_change", severity: "info", message: "analyst@example.org role changed from farm_manager to analyst", ip: "192.0.2.14", at: minutesAgo(60 * 20) },
  { id: 5, type: "account_suspended", severity: "info", message: "former@example.org was suspended by Sample Admin", ip: "192.0.2.14", at: minutesAgo(60 * 49) },
];
