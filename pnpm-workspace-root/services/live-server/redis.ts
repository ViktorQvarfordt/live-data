import { createClient } from "redis";

export const redisClient: ReturnType<typeof createClient> = createClient();

redisClient.on("error", (err) => console.log("Redis Client Error", err));

export async function initRedis() {
  await redisClient.connect();
}
