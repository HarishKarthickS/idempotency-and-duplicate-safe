const crypto = require('crypto');
const { db } = require('./db');

const OPERATION = 'POST:/incidents';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function hashRequest(body) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalize(body)))
    .digest('hex');
}

async function createIncident(req, res) {
  const key = req.get('Idempotency-Key');
  if (!key || !key.trim()) return res.status(400).json({ error: 'idempotency_key_required' });

  const { title, severity, serviceId } = req.body;
  const requestHash = hashRequest(req.body);
  const result = await db.tx(async t => {
    // The unique constraint serializes contenders. An expired row is the only
    // existing key that may be replaced; all local effects stay in this tx.
    const claimed = await t.oneOrNone(
      `INSERT INTO idempotency_keys
         (tenant_id, operation, key, request_hash, state, expires_at)
       VALUES ($1, $2, $3, $4, 'processing', now() + interval '24 hours')
       ON CONFLICT (tenant_id, operation, key) DO UPDATE
         SET request_hash = EXCLUDED.request_hash,
             state = 'processing',
             response_code = NULL,
             response_body = NULL,
             expires_at = EXCLUDED.expires_at
         WHERE idempotency_keys.expires_at <= now()
       RETURNING *`,
      [req.user.tenantId, OPERATION, key, requestHash]
    );

    const record = claimed || await t.one(
      `SELECT * FROM idempotency_keys
       WHERE tenant_id = $1 AND operation = $2 AND key = $3
       FOR UPDATE`,
      [req.user.tenantId, OPERATION, key]
    );

    // An existing key is immutable: replay, reject, or wait; never execute it twice.
    if (!claimed && record.request_hash !== requestHash) {
      return {
        status: 409,
        body: {
          error: 'idempotency_key_conflict',
          message: 'Idempotency-Key is already bound to a different request'
        }
      };
    }
    if (!claimed && record.state === 'completed') {
      return { status: record.response_code, body: record.response_body, replayed: true };
    }
    if (!claimed && record.state === 'processing') {
      return { status: 409, body: { error: 'operation_in_progress' } };
    }
    if (!claimed && record.state === 'failed') {
      return { status: 409, body: { error: 'prior_operation_failed' } };
    }

    const incident = await t.one(
      `INSERT INTO incidents (tenant_id, service_id, title, severity)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.user.tenantId, serviceId, title, severity]
    );
    await t.none('INSERT INTO paging_jobs (incident_id) VALUES ($1)', [incident.id]);
    await t.none(
      `UPDATE idempotency_keys
       SET state = 'completed', response_code = 201, response_body = $4
       WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
      [req.user.tenantId, OPERATION, key, incident]
    );
    return { status: 201, body: incident };
  });

  if (result.replayed) res.set('Idempotent-Replayed', 'true');
  return res.status(result.status).json(result.body);
}

module.exports = { createIncident, hashRequest };
