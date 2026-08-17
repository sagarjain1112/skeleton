# Firmware Release Publisher

Release bundles are being rejected with `UNTRUSTED_SIGNATURE` because release engineering rotated the firmware code-signing key, but the legacy publisher was not updated.

Your task is to implement the publisher in JavaScript to reconcile the build manifest, sign the bundles with the new key, and publish them.

## Requirements

1. **Reconcile the Manifest (DuckDB & SQL):**
   - Read `/app/fixtures/build_manifest.csv` into a DuckDB database (which you must create at `/app/releases.duckdb`).
   - The CSV contains columns: `entry_id, bundle_id, component_id, version, size_bytes, record_type, supersedes_id, recorded_at`.
   - **Duplicate Rule:** Collapse rows that are exactly identical across all columns.
   - **Withdrawal Rule:** A row with `record_type = 'WITHDRAWAL'` cancels the build referenced by its `supersedes_id` (matched against the `entry_id`).
   - A bundle is publishable if it has at least one surviving build after reconciliation.
   - For each publishable bundle, calculate `artifact_count` (number of surviving builds) and `total_bytes` (sum of `size_bytes`).

2. **Sign the Descriptors (OpenSSL):**
   - For each publishable bundle, create a canonical JSON descriptor: **UTF-8 JSON, lexicographically sorted object keys, no insignificant whitespace**. Example: `{"artifact_count":1,"bundle_id":"BND-101","total_bytes":100}`
   - Fetch the current key metadata by making a `GET` request to `http://127.0.0.1:7070/v1/signing-key/current`.
   - Sign the descriptor using OpenSSL CMS detached signing. Use the current certificate (`/app/keys/current/current.cert.pem`) and private key (`/app/keys/current/current.key.pem`). Do NOT use the revoked keys.
   - The output must be PEM-encoded binary. Example command: `openssl cms -sign -in <file> -signer <cert> -inkey <key> -outform PEM -binary`.

3. **Publish to the Gateway (HTTP):**
   - Submit each signed bundle via a `POST` request to `http://127.0.0.1:7070/v1/publications`.
   - Payload: `{"descriptor": "<json_string>", "signature": "<pem_string>", "request_token": "token-<bundle_id>"}`.

4. **Persist Receipts and Ensure Idempotency:**
   - The gateway will return a receipt with a `publication_id`, `request_token`, and `status`.
   - Store these in a `receipts` table in `/app/releases.duckdb`.
   - Before publishing, check if the bundle is already in the `receipts` table. If it is, reuse the receipt and skip the HTTP POST.

5. **Deterministic Output:**
   - Your script must be implemented in `/app/publisher/release-publisher.mjs`.
   - It will be executed via `npm run report`.
   - Print exactly two lines per publishable bundle, ordered alphabetically by `bundle_id`:
     ```
     BUNDLE <bundle_id> SIGNED KEY=<key_id>
     BUNDLE <bundle_id> PUBLISHED RECEIPT=<publication_id> TOKEN=<request_token> STATUS=PUBLISHED
     ```
   - This output must exactly match the format of `/app/reports/publications.expected.txt`.

## Constraints
- Do not read or modify the gateway ledger directly.
- Do not bypass signature verification.
- Use only the provided `duckdb` npm package and standard Node.js libraries.
