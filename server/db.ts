import * as pg from "pg";
import { SQL, SQLStatement } from "sql-template-strings";
import { z } from "zod";

export const sql = SQL;

// Disable parsing of dates into javascript Date objects, instead return string.
// Used to avoid erroneous encoding/decoding when just passing data along to client.
const TIMESTAMP_TYPEID = 1114;
const TIMESTAMPTZ_TYPEID = 1184;
const UUID_TYPEID = 2950;
const identity = <T>(x: T): T => x;
pg.types.setTypeParser(TIMESTAMP_TYPEID, identity);
pg.types.setTypeParser(TIMESTAMPTZ_TYPEID, identity);
pg.types.setTypeParser(UUID_TYPEID, (str) => str.replace(/-/g, ""));

const pool = new pg.Pool({
  user: "postgres",
  password: "password",
});

function snakeToCamel(
  snakeObj: Record<string, unknown>
): Record<string, unknown> {
  const camelObj: Record<string, unknown> = {};

  for (const snakeKey in snakeObj) {
    const words = snakeKey.split("_");
    const camelKey =
      words[0] +
      words
        .slice(1)
        .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
        .join("");

    camelObj[camelKey] = snakeObj[snakeKey];
  }

  return camelObj;
}

export function query(stmt: SQLStatement): Promise<pg.QueryResult> {
  if (typeof stmt === "string") {
    throw new Error("Got string expected SQLStatement. SQL injection warning.");
  }
  return pool.query(stmt);
}

export async function getExactlyOne<T>(
  schema: z.Schema<T>,
  stmt: SQLStatement
): Promise<T> {
  const { rows } = await query(stmt);
  if (rows.length === 1) return schema.parse(snakeToCamel(rows[0]));
  throw new Error(`Got ${rows.length} rows, expected exactly one`);
}

export async function getAll<T>(
  schema: z.Schema<T>,
  stmt: SQLStatement
): Promise<T[]> {
  const { rows } = await query(stmt);
  return rows.map((row) => schema.parse(snakeToCamel(row)));
}

export async function transaction<T>(
  f: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const data = await f(client);
    await client.query("commit");
    return data;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

async function init() {
  // await query(sql`drop table event_log`)

  await query(sql`
    CREATE TABLE IF NOT EXISTS event_log (
      id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      data JSONB,
      UNIQUE (id, entity_id)
    );
  `);
}

init();
