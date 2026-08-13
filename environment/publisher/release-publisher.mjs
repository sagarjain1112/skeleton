import duckdb from 'duckdb';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

/**
 * ReleasePublisherDB handles all interactions with the embedded DuckDB database.
 * This encapsulates data ingestion, reconciliation logic, and persistence.
 */
export class ReleasePublisherDB {
  constructor(dbPath = 'releases.duckdb') {
    this.db = new duckdb.Database(dbPath);
    this.connection = this.db.connect();
    
    // Promisify the callback-based duckdb methods for modern async/await usage
    this.allAsync = promisify(this.connection.all.bind(this.connection));
    this.execAsync = promisify(this.connection.exec.bind(this.connection));
  }

  /**
   * Initializes the database schema, loads the raw manifest, and builds the
   * reconciliation views to determine valid publishable bundles.
   */
  async initialize(manifestPath = 'fixtures/build_manifest.csv') {
    // Drop existing table to ensure idempotency across runs
    await this.execAsync(`DROP TABLE IF EXISTS raw_manifest;`);
    
    // 1. Ingest: Load CSV into raw_manifest
    await this.execAsync(`
      CREATE TABLE raw_manifest AS 
      SELECT * FROM read_csv_auto('${manifestPath}');
    `);

    // 2. Deduplicate: Collapse exact duplicates
    await this.execAsync(`
      CREATE OR REPLACE VIEW distinct_manifest AS 
      SELECT DISTINCT * FROM raw_manifest;
    `);

    // 3. Filter: Isolate active builds by applying withdrawals
    await this.execAsync(`
      CREATE OR REPLACE VIEW active_builds AS
      SELECT * FROM distinct_manifest
      WHERE record_type = 'BUILD'
        AND entry_id NOT IN (
          SELECT supersedes_id 
          FROM distinct_manifest 
          WHERE record_type = 'WITHDRAWAL' AND supersedes_id IS NOT NULL
        );
    `);

    // 4. Aggregate: Group by bundle to calculate final metrics
    // Note: CAST to INTEGER avoids JS BigInt serialization issues later in canonicalization
    await this.execAsync(`
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
  }

  /**
   * Retrieves all publishable bundles computed by the reconciliation logic.
   * @returns {Promise<Array>} Array of objects with bundle_id, artifact_count, total_bytes
   */
  async getPublishableBundles() {
    return await this.allAsync(`SELECT * FROM publishable_bundles;`);
  }

  /**
   * Safely closes the database connection.
   */
  async close() {
    return new Promise((resolve, reject) => {
      this.connection.close();
      this.db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

/**
 * Main execution block
 */
async function main() {
  // Using '--report' check for future steps, though not strictly required for Step 1
  const isReportMode = process.argv.includes('--report');
  
  const publisherDb = new ReleasePublisherDB();
  
  try {
    console.log('Initializing database and reconciling manifest...');
    await publisherDb.initialize();
    
    const bundles = await publisherDb.getPublishableBundles();
    
    console.log('\n--- Step 1: Reconciled Publishable Bundles ---');
    console.table(bundles);
    console.log('\nReconciliation complete. Ready for Step 2.');
    
  } catch (err) {
    console.error('Error during database initialization/reconciliation:', err);
    process.exit(1);
  } finally {
    await publisherDb.close();
  }
}

// Execute main if run directly (not imported as a module)
const __filename = fileURLToPath(import.meta.url);
const isMainModule = process.argv[1] === __filename;

if (isMainModule) {
  main();
}
