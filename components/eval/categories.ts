import type { EvalCase } from "@/db/schema";

export const categoryLabels: Record<EvalCase["category"], string> = {
  very_relevant: "Very relevant",
  somewhat_relevant: "Somewhat relevant",
  knows_little_to_add: "Knows it, little to add",
  irrelevant: "Irrelevant",
};
