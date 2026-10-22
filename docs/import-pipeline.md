# Trellis Bulk Import Pipeline Guide

## Overview
The Trellis Bulk Import Pipeline provides safe, idempotent ingestion of datasets (Agents, Test Cases, Provenance records, Submissions) with dry-run validation, duplicate detection, automated rollback guidance, and **safe in-flight cancellation** with transactional snapshot restoration.

---

## Key Features

1. **Dry-Run Validation (`dryRun: true`)**:
   - Evaluates input rows without applying persistent storage mutations.
   - Outputs summary statistics: `createCount`, `updateCount`, `skipCount`, `errorCount`, `duplicateCount`.

2. **Idempotency & Deduplication**:
   - Matches records on external identifier (`id` or custom key).
   - In-batch duplicate detection flags duplicate keys within the same payload.
   - Repeated imports with existing keys update or skip safely rather than creating duplicate records.

3. **Safe In-Flight Cancellation**:
   - Accepts an `AbortSignal` for instant cancellation via client disconnect or remote cancellation API.
   - Checkpoints cancellation before parsing, between row validations, and during persistent write execution.
   - **Automatic Snapshot Rollback**: When a live import (`dryRun: false`) is cancelled midway during write execution, the pipeline automatically restores the pre-import snapshot, guaranteeing that **no partial or corrupt records remain in storage**.

4. **Rollback & Compensation Guidance**:
   - Generates pre-import snapshot IDs and compensation step instructions for partial failures.
   - Provides executable SQL/API recovery scripts to restore previous states cleanly.

5. **Centralized Operation Cancellation Registry**:
   - Tracks active operations with lifecycle states: `running` -> `completed` | `cancelled` | `failed`.
   - Supports client tracking via `x-operation-id` headers and remote cancellation via `POST /api/operations/cancel`.
   - Enforces role-based authorization (admin, maintainer, or resource owner).

---

## Supported Formats

### 1. JSON Array
```json
[
  {
    "id": "agent-101",
    "name": "Yield Optimizer",
    "description": "Automated liquidity and yield management agent.",
    "category": "trading",
    "price": 50,
    "version": "1.0.0"
  }
]
```

### 2. CSV
```csv
id,name,description,category,price,version
agent-101,Yield Optimizer,Automated liquidity and yield management agent.,trading,50,1.0.0
agent-102,Governance Oracle,Monitors voting proposals on Soroban.,governance,25,1.1.0
```

---

## API Endpoints

### 1. Dry Run Validation
`POST /api/import/dry-run?entityType=agents`
- **Request Body**: JSON array or CSV text
- **Response**: Full validation summary and row diffs, zero persistent writes.

### 2. Live Ingestion
`POST /api/import?entityType=agents&dryRun=false`
- **Request Headers**:
  - `Content-Type`: `application/json` or `text/csv`
  - `Accept`: `application/json` (or `text/event-stream` for live progress streaming)
  - `Authorization`: `Bearer <token>` (enforces `import_data` permission)
  - `x-csrf-token`: `<token>` (required for state-changing browser mutations)
  - `x-operation-id`: `<optional-operation-id>`
- **Response**: `ImportResult` with `appliedRecords`, `rollbackGuidance`, and `x-operation-id` response header.

### 3. Remote Operation Cancellation
`POST /api/operations/cancel`
- **Request Headers**: `Authorization: Bearer <token>`
- **Request Body**:
  ```json
  {
    "operationId": "op_import_1729250000_abc123",
    "reason": "Operator requested emergency halt"
  }
  ```
- **Authorization**:
  - `admin` and `maintainer`: Can cancel any operation.
  - `contributor`: Can only cancel operations initiated by their own wallet.
  - `viewer` and `guest`: 403 Forbidden.

### 4. Operation Status Inspection
`GET /api/operations?id=<operationId>`
- **Request Headers**: `Authorization: Bearer <token>`
- **Response**: Status (`running`, `completed`, `cancelled`, `failed`), timestamps, and metadata.

---

## Safe Cancellation & Rollback Behavior

### Cancellation Checkpoints

| Pipeline Stage | Cancellation Trigger | Behavior | State Impact |
| :--- | :--- | :--- | :--- |
| **Pre-execution** | Signal aborted before parsing | Pipeline aborts immediately; returns `cancelled: true` | Zero records read or processed |
| **Row Validation** | Signal aborted during validation loop | Validation halts on current row; returns partial summary and `cancelled: true` | Zero storage mutations |
| **Persistent Writes** | Signal aborted during live mutations (`dryRun: false`) | **Automated Rollback**: Pipeline invokes `importStore.restoreSnapshot(snapshotId)` | All partially applied writes are undone; baseline state is 100% restored |

### Sample Cancelled Result Payload
```json
{
  "success": false,
  "cancelled": true,
  "cancellationReason": "Import was cancelled mid-write (row 45 of 100); state safely rolled back to pre-import snapshot",
  "cancelledAt": "2026-10-18T14:30:00.000Z",
  "dryRun": false,
  "entityType": "agents",
  "summary": {
    "totalRows": 100,
    "validRows": 100,
    "invalidRows": 0,
    "createCount": 100,
    "updateCount": 0,
    "skipCount": 0,
    "errorCount": 0,
    "duplicateCount": 0
  },
  "rows": [...],
  "errors": [
    "Import was cancelled during write execution. Automatic rollback restored previous state."
  ],
  "rollbackGuidance": {
    "snapshotId": "snap_1729250000_abc123",
    "timestamp": "2026-10-18T14:30:00.000Z",
    "rollbackSupported": true,
    "totalAffectedRecords": 100,
    "affectedExternalIds": ["agent-1", "agent-2", ...],
    "remediationSteps": [
      "Import was cancelled during persistent write execution.",
      "All partially written records were automatically rolled back to snapshot.",
      "Database state remains consistent and uncorrupted.",
      "Import can be safely retried idempotently when ready."
    ],
    "compensationSteps": [...]
  },
  "appliedRecords": []
}
```

---

## Operational Edge Cases & Recovery

### 1. Client Disconnection During Live Import
- **Scenario**: Network connection drops while importing a 10,000-row dataset via SSE (`Accept: text/event-stream`).
- **Recovery**: Next.js detects client disconnect (`request.signal.abort`). The pipeline catches the abort signal, rolls back any partial writes made in the current transaction, and cleans up stream controllers without crashing.

### 2. Idempotent Retry After Cancellation
- **Scenario**: An import is cancelled halfway through, and the operator wishes to resume or retry.
- **Recovery**: Because automatic rollback returned storage to its exact pre-import baseline, the operator can safely submit the full payload again with `idempotent: true`. Records with existing IDs will update or skip based on `allowUpdate`, with zero risk of duplicated IDs.

### 3. Duplicate External IDs in Payload
- **Scenario**: Two rows in the import payload share the same `id`.
- **Behavior**: Flagged as a batch duplicate in `summary.duplicateCount`. Import halts or records error rows, and `rollbackGuidance` provides external ID group remediation.

### 4. Unauthorized Cancellation Attempts
- **Scenario**: A `viewer` or an unauthorized third-party wallet attempts to cancel another user's running import via `POST /api/operations/cancel`.
- **Behavior**: The request is denied with `403 Forbidden` (`Role 'viewer' cannot cancel operations` or `Forbidden: You do not have permission to cancel operations owned by other wallets`).
