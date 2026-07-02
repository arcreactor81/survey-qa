// Per-language seeded-error manifests for scorecard computation.
// Each spec/canon[.<lang>].json is the single source of truth for its language.
import canonEn from "../spec/canon.json";
import canonEs from "../spec/canon.es.json";
import canonFr from "../spec/canon.fr.json";
import canonDe from "../spec/canon.de.json";
import canonZh from "../spec/canon.zh.json";
import canonJa from "../spec/canon.ja.json";

export interface SeededError {
  id: string;
  questionId: string;
  category: string;
  truth: string;
  rendered: string;
  note: string;
}

export const MANIFESTS: Record<string, SeededError[]> = {
  en: canonEn.seededErrors,
  es: canonEs.seededErrors,
  fr: canonFr.seededErrors,
  de: canonDe.seededErrors,
  zh: canonZh.seededErrors,
  ja: canonJa.seededErrors,
};

export const SUPPORTED_LANGS = Object.keys(MANIFESTS);
