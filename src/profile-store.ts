import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import type { PublicSnapshotV1 } from './public-snapshot.js';

export type ShareVisibility = 'private' | 'totals' | 'details';
export type LeaderboardMetric = 'tokens' | 'cost' | 'sessions';

export interface SharingProfile {
  subject: string;
  handle: string;
  display_name: string | null;
  visibility: ShareVisibility;
  leaderboard_opt_in: boolean;
  snapshot_generated_at: string | null;
}

export interface SharingUpdate {
  handle?: string;
  display_name?: string | null;
  visibility?: ShareVisibility;
  leaderboard_opt_in?: boolean;
}

export interface PublicProfile {
  handle: string;
  display_name: string | null;
  visibility: Exclude<ShareVisibility, 'private'>;
  snapshot: PublicSnapshotV1;
}

export interface LeaderboardUser {
  handle: string;
  display_name: string | null;
  value: number;
  generated_at: string;
}

export interface ProfileStore {
  init(): Promise<void>;
  getSharing(subject: string): Promise<SharingProfile | null>;
  upsertSharing(subject: string, update: SharingUpdate & { handle: string }): Promise<SharingProfile>;
  saveSnapshot(subject: string, snapshot: PublicSnapshotV1): Promise<void>;
  getPublicProfile(handle: string): Promise<PublicProfile | null>;
  getLeaderboard(metric: LeaderboardMetric, limit: number): Promise<LeaderboardUser[]>;
}

export class HandleConflictError extends Error {
  constructor() {
    super('Handle is already taken');
    this.name = 'HandleConflictError';
  }
}

export class InvalidHandleError extends Error {
  constructor(message = 'Handle must be 2-40 lowercase letters, digits or hyphens') {
    super(message);
    this.name = 'InvalidHandleError';
  }
}

export class StaleSnapshotError extends Error {
  constructor() {
    super('Snapshot is older than the stored snapshot');
    this.name = 'StaleSnapshotError';
  }
}

const HANDLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_HANDLES = new Set([
  'admin', 'api', 'auth', 'dashboard', 'leaderboard', 'login', 'logout', 'me', 'models',
  'profile', 'projects', 'public', 'sessions', 'settings', 'users',
]);

export function normalizeHandle(value: string): string {
  const handle = value.trim().toLowerCase();
  if (handle.length < 2 || handle.length > 40 || !HANDLE_RE.test(handle) || RESERVED_HANDLES.has(handle)) {
    throw new InvalidHandleError();
  }
  return handle;
}

function snapshotHash(snapshot: PublicSnapshotV1): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

interface MemoryRecord {
  profile: SharingProfile;
  snapshot: PublicSnapshotV1 | null;
}

export class MemoryProfileStore implements ProfileStore {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly subjectsByHandle = new Map<string, string>();

  async init(): Promise<void> {}

  async getSharing(subject: string): Promise<SharingProfile | null> {
    const record = this.records.get(subject);
    return record ? clone(record.profile) : null;
  }

  async upsertSharing(subject: string, update: SharingUpdate & { handle: string }): Promise<SharingProfile> {
    const handle = normalizeHandle(update.handle);
    const owner = this.subjectsByHandle.get(handle);
    if (owner && owner !== subject) throw new HandleConflictError();
    const existing = this.records.get(subject);
    if (existing && existing.profile.handle !== handle) this.subjectsByHandle.delete(existing.profile.handle);
    const profile: SharingProfile = {
      subject,
      handle,
      display_name: update.display_name !== undefined ? update.display_name : existing?.profile.display_name || null,
      visibility: update.visibility ?? existing?.profile.visibility ?? 'private',
      leaderboard_opt_in: update.leaderboard_opt_in ?? existing?.profile.leaderboard_opt_in ?? false,
      snapshot_generated_at: existing?.snapshot?.generated_at || null,
    };
    this.records.set(subject, { profile, snapshot: existing?.snapshot || null });
    this.subjectsByHandle.set(handle, subject);
    return clone(profile);
  }

  async saveSnapshot(subject: string, snapshot: PublicSnapshotV1): Promise<void> {
    const record = this.records.get(subject);
    if (!record) throw new Error('Sharing profile does not exist');
    if (record.snapshot && Date.parse(snapshot.generated_at) < Date.parse(record.snapshot.generated_at)) {
      throw new StaleSnapshotError();
    }
    record.snapshot = clone(snapshot);
    record.profile.snapshot_generated_at = snapshot.generated_at;
  }

  async getPublicProfile(rawHandle: string): Promise<PublicProfile | null> {
    let handle: string;
    try {
      handle = normalizeHandle(rawHandle);
    } catch {
      return null;
    }
    const subject = this.subjectsByHandle.get(handle);
    const record = subject ? this.records.get(subject) : undefined;
    if (!record?.snapshot || record.profile.visibility === 'private') return null;
    const snapshot = clone(record.snapshot);
    if (record.profile.visibility === 'totals') delete snapshot.details;
    return clone({
      handle: record.profile.handle,
      display_name: record.profile.display_name,
      visibility: record.profile.visibility,
      snapshot,
    } as PublicProfile);
  }

  async getLeaderboard(metric: LeaderboardMetric, limit: number): Promise<LeaderboardUser[]> {
    const key = metric === 'tokens' ? 'total_tokens' : metric === 'cost' ? 'total_cost' : 'total_sessions';
    return [...this.records.values()]
      .filter(record => record.profile.visibility !== 'private' && record.profile.leaderboard_opt_in && record.snapshot)
      .map(record => ({
        handle: record.profile.handle,
        display_name: record.profile.display_name,
        value: record.snapshot!.totals[key],
        generated_at: record.snapshot!.generated_at,
      }))
      .sort((left, right) => right.value - left.value || left.handle.localeCompare(right.handle))
      .slice(0, limit)
      .map(clone);
  }
}

export class PostgresProfileStore implements ProfileStore {
  readonly pool: Pool;

  constructor(connection: string | Pool) {
    this.pool = typeof connection === 'string' ? new Pool({ connectionString: connection }) : connection;
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS share_profiles (
        subject TEXT PRIMARY KEY,
        handle TEXT NOT NULL,
        display_name TEXT,
        visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'totals', 'details')),
        leaderboard_opt_in BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS share_profiles_handle_lower_idx ON share_profiles (LOWER(handle));
      CREATE TABLE IF NOT EXISTS public_snapshots (
        subject TEXT PRIMARY KEY REFERENCES share_profiles(subject) ON DELETE CASCADE,
        schema_version INTEGER NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL,
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        snapshot JSONB NOT NULL,
        total_cost NUMERIC(20,6) NOT NULL,
        total_tokens NUMERIC(30,0) NOT NULL,
        total_sessions BIGINT NOT NULL,
        snapshot_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS public_snapshots_cost_idx ON public_snapshots (total_cost DESC);
      CREATE INDEX IF NOT EXISTS public_snapshots_tokens_idx ON public_snapshots (total_tokens DESC);
      CREATE INDEX IF NOT EXISTS public_snapshots_sessions_idx ON public_snapshots (total_sessions DESC);
    `);
  }

  async getSharing(subject: string): Promise<SharingProfile | null> {
    const result = await this.pool.query(
      `SELECT p.subject, p.handle, p.display_name, p.visibility, p.leaderboard_opt_in,
              s.generated_at
         FROM share_profiles p LEFT JOIN public_snapshots s USING (subject)
        WHERE p.subject = $1`,
      [subject],
    );
    return result.rows[0] ? profileFromRow(result.rows[0]) : null;
  }

  async upsertSharing(subject: string, update: SharingUpdate & { handle: string }): Promise<SharingProfile> {
    const handle = normalizeHandle(update.handle);
    try {
      await this.pool.query(
        `INSERT INTO share_profiles (subject, handle, display_name, visibility, leaderboard_opt_in)
         VALUES ($1, $2, $3, COALESCE($4, 'private'), COALESCE($5, false))
         ON CONFLICT (subject) DO UPDATE SET
           handle = EXCLUDED.handle,
           display_name = CASE WHEN $6 THEN EXCLUDED.display_name ELSE share_profiles.display_name END,
           visibility = COALESCE($4, share_profiles.visibility),
           leaderboard_opt_in = COALESCE($5, share_profiles.leaderboard_opt_in),
           updated_at = NOW()`,
        [subject, handle, update.display_name ?? null, update.visibility ?? null, update.leaderboard_opt_in ?? null, update.display_name !== undefined],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new HandleConflictError();
      throw error;
    }
    return (await this.getSharing(subject))!;
  }

  async saveSnapshot(subject: string, snapshot: PublicSnapshotV1): Promise<void> {
    const result = await this.pool.query(
      `INSERT INTO public_snapshots
         (subject, schema_version, generated_at, snapshot, total_cost, total_tokens, total_sessions, snapshot_hash)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
       ON CONFLICT (subject) DO UPDATE SET
         schema_version = EXCLUDED.schema_version,
         generated_at = EXCLUDED.generated_at,
         uploaded_at = NOW(),
         snapshot = EXCLUDED.snapshot,
         total_cost = EXCLUDED.total_cost,
         total_tokens = EXCLUDED.total_tokens,
         total_sessions = EXCLUDED.total_sessions,
         snapshot_hash = EXCLUDED.snapshot_hash
       WHERE public_snapshots.generated_at <= EXCLUDED.generated_at`,
      [subject, snapshot.schema_version, snapshot.generated_at, JSON.stringify(snapshot), snapshot.totals.total_cost,
        snapshot.totals.total_tokens, snapshot.totals.total_sessions, snapshotHash(snapshot)],
    );
    if (result.rowCount === 0) throw new StaleSnapshotError();
  }

  async getPublicProfile(rawHandle: string): Promise<PublicProfile | null> {
    let handle: string;
    try {
      handle = normalizeHandle(rawHandle);
    } catch {
      return null;
    }
    const result = await this.pool.query(
      `SELECT p.handle, p.display_name, p.visibility, s.snapshot
         FROM share_profiles p JOIN public_snapshots s USING (subject)
        WHERE LOWER(p.handle) = $1 AND p.visibility <> 'private'`,
      [handle],
    );
    if (!result.rows[0]) return null;
    const snapshot = result.rows[0].snapshot as PublicSnapshotV1;
    if (result.rows[0].visibility === 'totals') delete snapshot.details;
    return {
      handle: result.rows[0].handle,
      display_name: result.rows[0].display_name,
      visibility: result.rows[0].visibility,
      snapshot,
    };
  }

  async getLeaderboard(metric: LeaderboardMetric, limit: number): Promise<LeaderboardUser[]> {
    const column = metric === 'tokens' ? 'total_tokens' : metric === 'cost' ? 'total_cost' : 'total_sessions';
    const result = await this.pool.query(
      `SELECT p.handle, p.display_name, s.${column}::double precision AS value, s.generated_at
         FROM share_profiles p JOIN public_snapshots s USING (subject)
        WHERE p.visibility <> 'private' AND p.leaderboard_opt_in = true
        ORDER BY s.${column} DESC, p.handle ASC LIMIT $1`,
      [limit],
    );
    return result.rows.map(row => ({
      handle: row.handle,
      display_name: row.display_name,
      value: row.value,
      generated_at: new Date(row.generated_at).toISOString(),
    }));
  }
}

function profileFromRow(row: Record<string, unknown>): SharingProfile {
  return {
    subject: String(row.subject),
    handle: String(row.handle),
    display_name: row.display_name === null ? null : String(row.display_name),
    visibility: row.visibility as ShareVisibility,
    leaderboard_opt_in: Boolean(row.leaderboard_opt_in),
    snapshot_generated_at: row.generated_at ? new Date(row.generated_at as string | Date).toISOString() : null,
  };
}

export function createProfileStoreFromEnv(): ProfileStore {
  const connectionString = process.env.PROFILE_DATABASE_URL || process.env.DATABASE_URL;
  return connectionString ? new PostgresProfileStore(connectionString) : new MemoryProfileStore();
}
