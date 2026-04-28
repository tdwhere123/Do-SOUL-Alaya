import { z } from "zod";

export const NonEmptyStringSchema = z.string().min(1);
export const IsoDatetimeStringSchema = z.string().datetime();
export const NonNegativeIntSchema = z.number().int().nonnegative();
export const PositiveIntSchema = z.number().int().positive();
