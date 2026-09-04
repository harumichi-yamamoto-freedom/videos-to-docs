/**
 * 「全文文字起こし」を**組み込みのプロンプトとして**扱うための定義。
 *
 * 設計 §6.0 のとおり、文字起こしは専用の画面・タブ・モードを作らず、
 * 既存の「音声を上げる → プロンプトを選ぶ → 文書ができる」に1つ足すだけにする。
 * こうすると一覧・検索・共有・PDF・編集・削除がすべて既存のまま効く。
 *
 * 🔴 Firestore には保存しない。クライアント側で一覧の先頭に差し込むだけ。
 * 利用者が編集・削除できる普通のプロンプトにすると、
 * 中身を書き換えられたときに分割パイプラインの前提が崩れる。
 */
import type { Prompt } from '@/lib/prompts';

/**
 * 予約 ID。
 * 🔴 **名前で判定してはいけない。** 利用者が同名のプロンプトを作れてしまい、
 * そちらが分割パイプラインへ流れる（あるいは逆に流れなくなる）。
 */
export const TRANSCRIPT_PROMPT_ID = '__builtin_transcript__';

export const TRANSCRIPT_PROMPT_NAME = '全文文字起こし';

/**
 * 組み込みプロンプトの実体。
 *
 * `content` は使われない（分割パイプラインは `transcription_config` で指示するため、
 * プロンプト本文を送らない）。一覧に説明として出す文言として持たせている。
 */
export const TRANSCRIPT_PROMPT: Prompt = {
    id: TRANSCRIPT_PROMPT_ID,
    name: TRANSCRIPT_PROMPT_NAME,
    content: '音声を分割して全文を文字起こしし、話者ラベルと時刻を付けた文書を作ります。',
    model: 'gemini-3.5-transcribe',
    isDefault: false,
    ownerType: 'guest',
    ownerId: 'BUILTIN',
    createdBy: 'BUILTIN',
    createdAt: new Date(0),
    updatedAt: new Date(0),
};

/** このプロンプトは分割パイプラインへ流す */
export function isTranscriptPrompt(prompt: { id?: string } | null | undefined): boolean {
    return prompt?.id === TRANSCRIPT_PROMPT_ID;
}

/**
 * 一覧の先頭に組み込みプロンプトを差し込む。
 *
 * 🔴 **既に同じ ID があれば差し込まない**（二重表示を防ぐ）。
 * 🔴 **利用者のプロンプトを1件も落とさない**。
 */
export function withTranscriptPrompt(prompts: readonly Prompt[]): Prompt[] {
    if (prompts.some(p => p.id === TRANSCRIPT_PROMPT_ID)) return [...prompts];
    return [TRANSCRIPT_PROMPT, ...prompts];
}
