# Author Notes

This task assesses a candidate's ability to integrate multiple systems (embedded SQL, cryptographic CLI tools, and HTTP APIs) while handling real-world edge cases like idempotency and key rotation.

- **Environment:** The environment sets up an Express gateway that verifies CMS signatures. The signing keys are generated at build time in the Dockerfile so that they are cryptographically valid.
- **Solution:** The reference solution is placed in `solution/release-publisher.mjs`, which correctly implements the DuckDB reconciliation, canonical JSON formatting, OpenSSL invocation, and idempotent HTTP posting.
- **Tests:** The `tests/test_outputs.py` script drives the verification by checking the stdout of `npm run report`, ensuring it matches the expected golden file (masking the random receipt IDs), and directly querying `releases.duckdb` to ensure receipts are persisted and idempotency is respected on subsequent runs.
