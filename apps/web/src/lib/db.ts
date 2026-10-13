import { createPool } from '@rentpro/db';
type Pool = ReturnType<typeof createPool>;

const g = globalThis as unknown as { __pool?: Pool };

export const pool = (): Pool =>
  (g.__pool ??= createPool(process.env.DATABASE_URL ?? 'postgresql://rentpro_app:rentpro_app@localhost:5432/rentpro'));
