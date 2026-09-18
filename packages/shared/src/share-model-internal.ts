import { z } from "zod"
export const DerivedFromSchema = z.strictObject({
  shareId: z
    .string()
    .length(22)
    .regex(/^[A-Za-z0-9_-]+$/),
  revision: z.number().int().min(1),
})
export type DerivedFrom = z.infer<typeof DerivedFromSchema>
