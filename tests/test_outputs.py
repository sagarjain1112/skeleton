"""Verifier tests for the Firmware Release Publisher task.

This script is run by the Harbor testing harness to grade the candidate's implementation.
The tests check the standard output of `npm run report`, verify state inside the DuckDB
database, and test the idempotency requirements.
"""

import subprocess
import duckdb
import os
import json
import re
import urllib.request
import urllib.error
import pytest

def test_report_output_matches():
    """functional_criteria[id=report_output_matches]"""
    # Run the candidate's script via the configured npm entrypoint
    result = subprocess.run(["npm", "run", "report"], capture_output=True, text=True, cwd="/app")
    
    # Grab just the BUNDLE lines from stdout
    actual_lines = [line.strip() for line in result.stdout.splitlines() if line.strip().startswith("BUNDLE")]
    
    with open("/app/reports/publications.expected.txt") as f:
        expected_lines = [line.strip() for line in f.read().splitlines() if line.strip().startswith("BUNDLE")]
        
    # Mask out the dynamically generated receipt IDs since they change every run
    def mask(lines):
        return [re.sub(r"RECEIPT=\S+", "RECEIPT=<id>", line) for line in lines]
        
    assert mask(actual_lines) == mask(expected_lines), "CLI output doesn't match the expected golden file formatting"


def test_receipts_and_tokens_persisted_in_duckdb():
    """functional_criteria[id=receipts_and_tokens_persisted_in_duckdb]
       functional_criteria[id=withdrawals_and_duplicates_reconciled]
       functional_criteria[id=bundles_signed_with_current_key_accepted]"""
    
    assert os.path.exists('/app/releases.duckdb'), "releases.duckdb was not created by the publisher script"
    
    with duckdb.connect('/app/releases.duckdb', read_only=True) as con:
        res = con.execute("SELECT bundle_id, publication_id, request_token FROM receipts ORDER BY bundle_id").fetchall()
    
    # The expected output only has 3 valid bundles after reconciliation
    assert len(res) == 3, f"Expected exactly 3 valid bundles in the receipts table, but got {len(res)}"
    
    # Make sure the publication IDs look legit
    for row in res:
        pub_id = row[1]
        assert pub_id and str(pub_id).startswith("pub_"), f"Publication ID {pub_id} looks invalid"


def test_idempotent_rerun_no_duplicate_publications():
    """functional_criteria[id=idempotent_rerun_no_duplicate_publications]"""
    with duckdb.connect('/app/releases.duckdb', read_only=True) as con:
        initial_res = con.execute("SELECT bundle_id, publication_id, request_token FROM receipts ORDER BY bundle_id").fetchall()
    
    # Run it a second time to trigger the idempotency check
    subprocess.run(["npm", "run", "report"], capture_output=True, text=True, cwd="/app")
    
    with duckdb.connect('/app/releases.duckdb', read_only=True) as con2:
        rerun_res = con2.execute("SELECT bundle_id, publication_id, request_token FROM receipts ORDER BY bundle_id").fetchall()
    
    # The DB shouldn't change at all on a second run
    assert initial_res == rerun_res, "Receipts changed during the second run; idempotency is broken"


def test_revoked_key_signature_rejected():
    """functional_criteria[id=revoked_key_signature_rejected]"""
    # Fire a bogus signature at the gateway to make sure it's actually validating them
    data = json.dumps({
        "descriptor": '{"artifact_count":1,"bundle_id":"BND-TEST","total_bytes":100}',
        "signature": "garbage_signature_that_fails_verification",
        "request_token": "test-token"
    }).encode('utf-8')
    
    req = urllib.request.Request("http://127.0.0.1:7070/v1/publications", data=data, headers={'Content-Type': 'application/json'})
    
    try:
        response = urllib.request.urlopen(req)
        resp_data = json.loads(response.read().decode('utf-8'))
        assert "UNTRUSTED" in resp_data.get("error", ""), "Gateway accepted a bogus signature without throwing an UNTRUSTED error"
    except urllib.error.HTTPError as e:
        # Gateway returns 400 Bad Request if signature verify fails, read the error body
        resp_data = json.loads(e.read().decode('utf-8'))
        assert "UNTRUSTED" in resp_data.get("error", ""), "Gateway failed but didn't throw an UNTRUSTED error"
