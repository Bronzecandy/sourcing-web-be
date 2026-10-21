/** PostgreSQL `integer` (int4) bounds. */
export const PG_INT4_MAX = 2_147_483_647;
export const PG_INT4_MIN = -2_147_483_648;

export function hashStringToNumber(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  if (hash === PG_INT4_MIN) return PG_INT4_MAX;
  return Math.abs(hash);
}

/**
 * Coerce CSV / unified IDs into a value Postgres `integer` columns can store.
 * Sensor Tower / some store IDs exceed int4 (e.g. 6756247787) and crash Prisma (P2020).
 */
export function toPostgresIntAppId(value: number | string): number {
  const raw = String(value).trim();
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= PG_INT4_MIN && n <= PG_INT4_MAX) return n;
  }
  return hashStringToNumber(raw);
}
