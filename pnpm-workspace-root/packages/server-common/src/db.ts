import pg from "pg";
import { SQL, SQLStatement } from "sql-template-strings";
import type { z } from "zod";

export const sql = SQL;

// https://github.com/brianc/node-pg-types
const TIMESTAMP_TYPEID = 1114;
const TIMESTAMPTZ_TYPEID = 1184;
// const UUID_TYPEID = 2950;
const INT8_TYPEID = 20;

const identity = <T>(x: T): T => x;

// Disable parsing of dates into javascript Date objects, instead return string.
// Used to avoid erroneous encoding/decoding when just passing data along to client.
pg.types.setTypeParser(TIMESTAMP_TYPEID, identity);
pg.types.setTypeParser(TIMESTAMPTZ_TYPEID, identity);
pg.types.setTypeParser(INT8_TYPEID, str => {
  const x = parseInt(str)
  if (x > Number.MAX_SAFE_INTEGER || x < Number.MIN_SAFE_INTEGER) {
    throw new Error('Overflow')
  }
  return x
});

const pool = new pg.Pool({
  connectionString: 'postgresql://postgres:password@127.0.0.1:5432/postgres'
});

const snakeToCamel = (snake: string): string => {
  const words = snake.split("_");
  const camelKey =
    words[0] +
    words
      .slice(1)
      .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
      .join("");

      return camelKey
}

function normalize(
  snakeObj: Record<string, unknown>
): Record<string, unknown> {
  const camelObj: Record<string, unknown> = {};
  for (const snakeKey in snakeObj) {
    camelObj[snakeToCamel(snakeKey)] = snakeObj[snakeKey];
  }

  for (const key in camelObj) {
    const val = camelObj[key]
    if (val === null || val === undefined) {
      delete camelObj[key]
    }
  }

  return camelObj;
}

export function query(stmt: SQLStatement): Promise<pg.QueryResult> {
  if (typeof stmt === "string") {
    throw new Error("Got string expected SQLStatement. SQL injection warning.");
  }
  return pool.query(stmt);
}

export async function getExactlyOne<T extends z.ZodType>(
  schema: T,
  stmt: SQLStatement
): Promise<z.infer<T>> {
  const { rows } = await query(stmt);
  if (rows.length === 1) return schema.parse(normalize(rows[0]));
  throw new Error(`Got ${rows.length} rows, expected exactly one`);
}

export async function getAll<T extends z.ZodType>(
  schema: T,
  stmt: SQLStatement
): Promise<z.infer<T>[]> {
  const { rows } = await query(stmt);
  return rows.map((row) => schema.parse(normalize(row)));
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
  await query(sql`
    -- DROP TABLE chat_messages;
    -- DROP TABLE entity_versions;

    CREATE TABLE IF NOT EXISTS presence (
      channel_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      -- user_id TEXT NOT NULL, -- TODO Add this when auth is in place
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      data JSONB,
      UNIQUE (channel_id, client_id)
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      message_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      chat_sequence_id BIGINT NOT NULL,
      message_sequence_id BIGINT NOT NULL,
      timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

      created_at TIMESTAMP WITH TIME ZONE NOT NULL,
      is_deleted BOOLEAN,
      text TEXT,

      -- UNIQUE (message_id, message_sequence_id),
      UNIQUE (chat_id, chat_sequence_id)
    );

    CREATE TABLE IF NOT EXISTS entity_versions (
      timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_version_id BIGINT NOT NULL,
      entity_sequence_id BIGINT NOT NULL,
      data JSONB,
      UNIQUE (entity_id, entity_version_id)
    );
  `);
}

init();
