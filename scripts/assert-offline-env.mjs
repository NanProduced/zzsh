// These switches enter PostgreSQL in the API offline suite's imported tests.
// Reject rather than erase them: a requested PG run must not become a green skip.
for (const key of ["REAL_SOURCE_5_CREDENTIALS_FILE", "ADM_FINANCE_QUERY_PG", "ADMIN_READ_PG_CREDENTIALS"]) {
  if (process.env[key]) throw new Error(`Offline tests reject ${key}; use its explicit, authorized PG entry.`);
}
