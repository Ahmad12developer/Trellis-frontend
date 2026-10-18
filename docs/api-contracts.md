# Trellis Public API Contracts & Drift Guide

## Overview
This document specifies the contract definitions, request/response formats, authentication, and error codes for Trellis Frontend endpoints. Automated drift tests enforce that live endpoints match these specifications.

---

## Endpoint Catalog

### 1. Affiliate Endpoints

#### `GET /api/affiliates`
- **Description**: Lists all affiliate sub-endpoints.
- **Auth**: None
- **Response Format**:
```json
{
  "message": "Affiliate API endpoints",
  "endpoints": {
    "stats": "GET /api/affiliates/stats?wallet=<address>",
    "earnings": "GET /api/affiliates/earnings?wallet=<address>&days=<number>",
    "payouts": "GET /api/affiliates/payouts?wallet=<address>",
    "program": "GET /api/affiliates/program",
    "referrals": "GET /api/affiliates/referrals?wallet=<address>",
    "validate": "GET /api/affiliates/validate?wallet=<address>"
  }
}
```

#### `GET /api/affiliates/program`
- **Description**: Returns affiliate program tiers and commission rates.
- **Response Format**:
```json
{
  "tiers": [
    { "name": "Bronze", "commissionRate": 0.05, "minVolumeXlm": 0 },
    { "name": "Silver", "commissionRate": 0.10, "minVolumeXlm": 5000 },
    { "name": "Gold", "commissionRate": 0.15, "minVolumeXlm": 25000 }
  ],
  "cookieDurationDays": 30
}
```

---

### 2. Metrics & Observability

#### `GET /api/metrics/panels`
- **Description**: Returns all configured dashboard panels.
- **Response Format**:
```json
{
  "source": "prometheus | mock",
  "panels": [
    { "id": "agent-executions", "title": "Agent Invocations", "type": "timeseries" }
  ]
}
```

---

### 3. Bulk Ingestion Pipeline

#### `POST /api/import/dry-run`
- **Description**: Previews import changes with zero persistent writes.
- **Query Params**:
  - `entityType` (optional, default: `general`): `agents` | `test-cases` | `provenance` | `submissions`
- **Response Format (200 OK)**:
```json
{
  "success": true,
  "dryRun": true,
  "entityType": "agents",
  "summary": {
    "totalRows": 1,
    "validRows": 1,
    "invalidRows": 0,
    "createCount": 1,
    "updateCount": 0,
    "skipCount": 0,
    "errorCount": 0,
    "duplicateCount": 0
  },
  "rows": [
    { "rowNumber": 1, "action": "create", "valid": true, "errors": [] }
  ]
}
```

---

## Error Handling Standards
All API error responses follow the standard Trellis error payload:
```json
{
  "error": "Human readable error message",
  "code": "ERROR_CODE_STRING",
  "details": []
}
```

Routes backed by the problem-details taxonomy additionally return an RFC 9457
`application/problem+json` document. That shape is a strict superset: `error`
and `code` are unchanged, and `detail`, `remediation`, `retryable`, `docs`,
`taxonomyVersion`, and `correlationId` are additive. `code` values are stable
machine codes from `lib/api-contracts/problem-details.ts`; the full catalog,
payload example, edge cases, and recovery steps live in
[`docs/problem-details.md`](./problem-details.md).
