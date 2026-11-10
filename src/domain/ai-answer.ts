import { z } from "zod";
import {
  DRAFT_ANSWER_MAX_LENGTH,
  DRAFT_QUESTION_MAX_LENGTH,
  MAX_QUESTION_CATEGORIES,
} from "./limits.ts";

export const aiClassificationSchema = z.object({
  categoryIds: z.array(z.string().min(1)).max(MAX_QUESTION_CATEGORIES),
  title: z.string().trim().min(1).optional(),
});

export type AiClassification = z.infer<typeof aiClassificationSchema>;

export const aiAnswerSchema = z.object({
  text: z.string(),
  referencedKnowledgeIds: z.array(z.string()),
  escalate: z.boolean(),
  reason: z.string(),
});

export type AiAnswer = z.infer<typeof aiAnswerSchema>;

export const aiSummarySchema = z.object({
  question: z.string().trim().min(1).max(DRAFT_QUESTION_MAX_LENGTH),
  answer: z.string().trim().min(1).max(DRAFT_ANSWER_MAX_LENGTH),
});

export type AiSummary = z.infer<typeof aiSummarySchema>;
