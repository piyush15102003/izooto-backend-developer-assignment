import mysql from 'mysql2/promise';
import { config } from './config';

export const pool = mysql.createPool({
  ...config.db,
  connectionLimit: 10,
});

export function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: string })?.code === 'ER_DUP_ENTRY';
}
