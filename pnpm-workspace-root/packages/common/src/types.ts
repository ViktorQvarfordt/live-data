import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null
export type Json = JsonPrimitive | { [key: string]: Json } | Json[]

export const JsonPrimitive = z.union([z.string(), z.number(), z.boolean(), z.null()])

export const Json: z.ZodType<Json> = z.lazy(() =>
  z.union([JsonPrimitive, z.array(Json), z.record(Json)])
)
