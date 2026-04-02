import { queryOne, run } from '@/lib/db';

const DEFAULT_OWNER_ID = `${process.pid}:${crypto.randomUUID()}`;
let ownerOverrideForTests: string | null = null;

function resolveOwnerId(ownerId?: string): string {
  return ownerId || ownerOverrideForTests || DEFAULT_OWNER_ID;
}

export function acquireRuntimeLease(
  name: string,
  options?: {
    ownerId?: string;
    ttlMs?: number;
    now?: string;
  },
): boolean {
  const ttlMs = Math.max(1, options?.ttlMs ?? 60_000);
  const nowIso = options?.now || new Date().toISOString();
  const expiresAt = new Date(new Date(nowIso).getTime() + ttlMs).toISOString();
  const ownerId = resolveOwnerId(options?.ownerId);

  const result = run(
    `INSERT INTO runtime_leases (name, owner_id, expires_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE
     SET owner_id = excluded.owner_id,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at
     WHERE runtime_leases.owner_id = excluded.owner_id
        OR runtime_leases.expires_at <= excluded.updated_at`,
    [name, ownerId, expiresAt, nowIso],
  );

  return result.changes > 0;
}

export function getRuntimeLease(name: string): {
  name: string;
  owner_id: string;
  expires_at: string;
  updated_at: string;
} | null {
  return (
    queryOne<{
      name: string;
      owner_id: string;
      expires_at: string;
      updated_at: string;
    }>('SELECT * FROM runtime_leases WHERE name = ?', [name]) || null
  );
}

export function setRuntimeLeaseOwnerForTests(ownerId: string | null): void {
  ownerOverrideForTests = ownerId;
}
