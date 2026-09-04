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
 * 🔴 プレビュー版であることの断り（設計 §3.7・2026-09-04 東野裁定）。
 *
 * 主エンジンの `MAI-Transcribe-2` は **public preview で SLA が無い**。逐語:
 * "This preview is provided without a service-level agreement, and is not recommended for
 *  production workloads." 実測でも 408 / 503 `diarization_unavailable` / 500 / 接続断が出る。
 * 落ちたチャンクは Gemini へ回すので**本文は出る**が、時間がかかったり結果が揺れたりする。
 *
 * 🔴 **「不安定」とだけ書かない。** 何が起きうるかと、そのとき利用者が何をすればよいかまで書く
 * （§6.5「画面の案内は、画面にある操作と正本にある語だけで」）。
 */
export const TRANSCRIPT_PREVIEW_NOTICE =
    '最新の文字起こしサービス（プレビュー版）を使っています。'
    + '混み合っているときは時間がかかったり、一部の区間だけ精度が落ちることがあります。'
    + 'うまくいかないときは、少し時間をおいてからもう一度お試しください。';

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
    // 🔴 表示用の名前。実際にどのエンジンが起こしたかはチャンクごとに変わる (設計 §3.7) ので、
    //    ここに書いた値を「このモデルで起こした」という意味に使ってはいけない。
    model: 'MAI-Transcribe-2',
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
