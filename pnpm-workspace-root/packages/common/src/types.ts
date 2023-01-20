import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type Json = JsonPrimitive | { [key: string]: Json } | Json[];

export const JsonPrimitive = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const Json: z.ZodType<Json> = z.lazy(() =>
  z.union([JsonPrimitive, z.array(Json), z.record(Json)])
);

export const PresenceUpsert = z.object({
  type: z.literal("upsert"),
  channelId: z.string(),
  clientId: z.string(),
  data: Json,
});
export type PresenceUpsert = z.infer<typeof PresenceUpsert>;

export const PresenceHeartbeat = z.object({
  channelId: z.string(),
  clientId: z.string(),
});
export type PresenceHeartbeat = z.infer<typeof PresenceHeartbeat>;

export const PresenceDelete = z.object({
  type: z.literal("delete"),
  channelId: z.string(),
  clientId: z.string(),
});
export type PresenceDelete = z.infer<typeof PresenceDelete>;

export const PresenceUpdate = z.discriminatedUnion("type", [
  PresenceUpsert,
  PresenceDelete,
]);
export type PresenceUpdate = z.infer<typeof PresenceUpdate>;

export const PresenceUpdates = z.array(PresenceUpdate);
export type PresenceUpdates = z.infer<typeof PresenceUpdates>;

export const PubMsg = z.object({
  channelId: z.string(),
  clientId: z.string().or(z.null()),
  messages: Json.array(),
});
export type PubMsg = z.infer<typeof PubMsg>;

export const RedisMessage = z.object({
  clientId: z.string().or(z.null()), // Used to prevent echo
  domainMessages: Json.array(),
});
export type RedisMessage = z.infer<typeof RedisMessage>;
