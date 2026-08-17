import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { execFileSync } from 'child_process';
import duckdb from 'duckdb';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CURRENT_CERT = process.env.CURRENT_CERT || path.resolve(__dirname, '../keys/current/current.cert.pem');
const CURRENT_KEY = process.env.CURRENT_KEY || path.resolve(__dirname, '../keys/current/current.key.pem');
const GATEWAY_URL = 'http://127.0.0.1:7070';

class PublisherDB {
  constructor(dbPath = 'releases.duckdb') {
    this.db = new duckdb.Database(dbPath);
    this.conn = this.db.connect();
    this.query = promisify(this.conn.all.bind(this.conn));
    this.exec = promisify(this.conn.exec.bind(this.conn));
  }

  async setup(manifest = 'fixtures/build_manifest.csv') {
    await this.exec('DROP TABLE IF EXISTS raw_manifest;');
    
    await this.exec(`
      CREATE TABLE raw_manifest AS SELECT * FROM read_csv_auto('${manifest}');
    `);

    await this.exec(`
      CREATE OR REPLACE VIEW active_builds AS
      SELECT * FROM (SELECT DISTINCT * FROM raw_manifest)
      WHERE record_type = 'BUILD'
        AND entry_id NOT IN (
          SELECT supersedes_id FROM raw_manifest WHERE record_type = 'WITHDRAWAL' AND supersedes_id IS NOT NULL
        );
    `);

    await this.exec(`
      CREATE OR REPLACE VIEW publishable_bundles AS
      SELECT 
          bundle_id, 
          CAST(COUNT(*) AS INTEGER) AS artifact_count, 
          CAST(SUM(size_bytes) AS INTEGER) AS total_bytes
      FROM active_builds 
      GROUP BY bundle_id 
      HAVING COUNT(*) > 0 
      ORDER BY bundle_id ASC;
    `);

    await this.exec(`
      CREATE TABLE IF NOT EXISTS receipts (
        bundle_id VARCHAR PRIMARY KEY,
        publication_id VARCHAR,
        request_token VARCHAR
      );
    `);
  }

  async getBundles() {
    return this.query('SELECT * FROM publishable_bundles;');
  }

  async getReceipt(bundleId) {
    const rows = await this.query('SELECT * FROM receipts WHERE bundle_id = ?;', bundleId);
    return rows.length ? rows[0] : null;
  }

  async saveReceipt(bundleId, pubId, token) {
    await this.exec(`
      INSERT INTO receipts (bundle_id, publication_id, request_token)
      VALUES ('${bundleId}', '${pubId}', '${token}')
      ON CONFLICT (bundle_id) DO UPDATE SET 
        publication_id = excluded.publication_id,
        request_token = excluded.request_token;
    `);
  }

  close() {
    return new Promise((resolve) => {
      this.conn.close();
      this.db.close(() => resolve());
    });
  }
}

async function getKeyInfo() {
  const res = await fetch(`${GATEWAY_URL}/v1/signing-key/current`);
  if (!res.ok) throw new Error(`Gateway returned ${res.status}`);
  return res.json();
}

function canonicalEncode(bundle) {
  // Ensure strict ordering for the signature payload
  const obj = {
    artifact_count: bundle.artifact_count,
    bundle_id: bundle.bundle_id,
    total_bytes: bundle.total_bytes
  };
  
  const sorted = {};
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = obj[k];
  }
  return JSON.stringify(sorted);
}

function sign(payload) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-'));
  const payloadFile = path.join(tmpDir, 'payload.bin');
  
  try {
    fs.writeFileSync(payloadFile, payload);
    const out = execFileSync(
      'openssl',
      ['cms', '-sign', '-in', payloadFile, '-signer', CURRENT_CERT, '-inkey', CURRENT_KEY, '-outform', 'PEM', '-binary']
    );
    return out.toString('utf8');
  } catch (err) {
    throw new Error(`Signing failed: ${err.stderr ? err.stderr.toString() : err.message}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function publish(descriptor, signature, token) {
  const res = await fetch(`${GATEWAY_URL}/v1/publications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ descriptor, signature, request_token: token })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

async function run() {
  const db = new PublisherDB();
  
  try {
    await db.setup();
    const keyInfo = await getKeyInfo();
    const bundles = await db.getBundles();
    
    for (const b of bundles) {
      const descriptor = canonicalEncode(b);
      const signature = sign(descriptor);
      const token = `token-${b.bundle_id}`;
      
      console.log(`BUNDLE ${b.bundle_id} SIGNED KEY=${keyInfo.key_id}`);
      
      let receipt = await db.getReceipt(b.bundle_id);
      
      if (!receipt) {
        const result = await publish(descriptor, signature, token);
        receipt = {
          publication_id: result.publication_id,
          request_token: token
        };
        await db.saveReceipt(b.bundle_id, receipt.publication_id, receipt.request_token);
      }
      
      console.log(`BUNDLE ${b.bundle_id} PUBLISHED RECEIPT=${receipt.publication_id} TOKEN=${receipt.request_token} STATUS=PUBLISHED`);
    }
  } catch (e) {
    console.error('Fatal error:', e.message);
    process.exit(1);
  } finally {
    await db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run();
}
