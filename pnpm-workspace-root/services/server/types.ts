import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null
export type Json = JsonPrimitive | { [key: string]: Json } | Json[]

export const JsonPrimitive = z.union([z.string(), z.number(), z.boolean(), z.null()])

export const Json: z.ZodType<Json> = z.lazy(() =>
  z.union([JsonPrimitive, z.array(Json), z.record(Json)])
)

export const PresenceUpsert = z.object({ type: z.literal("upsert"), clientId: z.string(), data: Json })
export const PresenceDelete = z.object({ type: z.literal("delete"), clientId: z.string() })
export const PresenceUpdate = z.discriminatedUnion("type", [ PresenceUpsert, PresenceDelete ]);
export const PresenceUpdates = z.array(PresenceUpdate);

export type PresenceUpsert = z.infer<typeof PresenceUpsert>
export type PresenceDelete = z.infer<typeof PresenceDelete>
export type PresenceUpdate = z.infer<typeof PresenceUpdate>
export type PresenceUpdates = z.infer<typeof PresenceUpdates>
