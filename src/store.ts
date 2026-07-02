import type { Env, RunReport } from "./types";

export interface RunEnvelope {
  status: "processing" | "awaiting-claude" | "complete" | "failed";
  seeded: boolean;
  lang?: string; // questionnaire/survey language (default "en")
  error?: string;
  report: RunReport;
}

export const runKey = (id: string) => `runs/${id}/run.json`;
export const shotKey = (id: string, i: number) => `runs/${id}/shot-${i}.png`;
export const pagePdfKey = (id: string, i: number) => `runs/${id}/page-${i}.pdf`;
export const docxKey = (id: string) => `runs/${id}/questionnaire.docx`;

export async function getRun(env: Env, id: string): Promise<RunEnvelope | null> {
  const obj = await env.ARTIFACTS.get(runKey(id));
  return obj ? ((await obj.json()) as RunEnvelope) : null;
}

export async function putRun(env: Env, id: string, envelope: RunEnvelope): Promise<void> {
  await env.ARTIFACTS.put(runKey(id), JSON.stringify(envelope), {
    httpMetadata: { contentType: "application/json" },
  });
}
