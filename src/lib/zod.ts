import { z } from 'zod';

/**
 * Like `.partial()`, but drops `.default()`s so a field left out of a PATCH stays
 * untouched instead of being reset to its default (zod applies defaults inside
 * `.partial()`).
 */
export function patchOf<S extends z.ZodRawShape>(schema: z.ZodObject<S>) {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, v] of Object.entries(schema.shape)) shape[k] = (v instanceof z.ZodDefault ? (v.unwrap() as z.ZodType) : (v as z.ZodType)).optional();
  return z.object(shape) as unknown as z.ZodObject<{ [K in keyof S]: z.ZodOptional<S[K]> }>;
}
