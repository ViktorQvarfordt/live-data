import { z } from "zod";

export type Op = {
  chatId: string;
  messageId: string;
} & ({ text: string } | { isDeleted: true });

export const Message = z.object({
  messageId: z.string(),
  chatId: z.string(),
  chatSequenceId: z.number(),
  messageSequenceId: z.number(),
  createdAt: z.string(),
  isDeleted: z.boolean().optional(),
  text: z.string().optional(),
  isOptimistic: z.boolean().optional(),
});
export type Message = z.infer<typeof Message>;

export const Messages = z.array(Message);

