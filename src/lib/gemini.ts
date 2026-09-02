import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { DEFAULT_GEMINI_MODEL, resolveGeminiModel } from '../constants/geminiModels';
import {
    resolveThinkingLevelForModel,
    type GeminiThinkingLevel,
} from '../constants/geminiThinking';
import { createLogger } from './logger';
import {
    INLINE_REQUEST_BUDGET_BYTES,
    describeInlineBudgetExceeded,
    selectMediaTransport,
    utf8ByteLength,
} from './inlineMediaBudget';

const geminiLogger = createLogger('gemini');

export interface TranscriptionResult {
    success: boolean;
    text?: string;
    error?: string;
    usedModel?: string;
    usedThinkingLevel?: string;
}

/** S2-1: Files API へアップロード済みのメディア参照。生成後は name で削除する */
export interface UploadedMediaRef {
    name: string;
    fileUri: string;
    mimeType: string;
}

export interface UploadMediaOptions {
    signal?: AbortSignal;
    pollIntervalMs?: number;
    timeoutMs?: number;
}

/** Files API のファイルが ACTIVE になるのを待つ間隔と上限 (動画は PROCESSING が長引くことがある) */
export const FILES_API_ACTIVATION_POLL_MS = 2_000;
export const FILES_API_ACTIVATION_TIMEOUT_MS = 5 * 60 * 1000;

interface GeminiUsageMetadata {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
}

/** generateContent へ渡すメディアの出所。inline は Base64、file は Files API の URI */
type MediaSource =
    | { kind: 'inline'; base64Data: string; mimeType: string }
    | { kind: 'file'; fileUri: string; mimeType: string };

const THINKING_LEVEL_ENUMS = {
    LOW: ThinkingLevel.LOW,
    MEDIUM: ThinkingLevel.MEDIUM,
    HIGH: ThinkingLevel.HIGH,
} as const;

const VIDEO_DEFAULT_PROMPT = `
以下の動画ファイルの内容を分析し、以下の形式でMarkdown文書を作成してください：

# タイトル
（動画の主題を簡潔に）

## 要約
（内容の要約を3-5文で）

## 詳細な内容
（話されている内容を詳しく記述）

## キーポイント
- （重要なポイント1）
- （重要なポイント2）
- （重要なポイント3）

動画が日本語の場合は日本語で、英語の場合は英語で文書を作成してください。
`.trim();

const AUDIO_DEFAULT_PROMPT = `
以下の音声ファイルの内容を分析し、以下の形式でMarkdown文書を作成してください：

# タイトル
（音声の主題を簡潔に）

## 要約
（内容の要約を3-5文で）

## 詳細な内容
（話されている内容を詳しく記述）

## キーポイント
- （重要なポイント1）
- （重要なポイント2）
- （重要なポイント3）

音声が日本語の場合は日本語で、英語の場合は英語で文書を作成してください。
`.trim();

const defaultPromptFor = (mimeType: string): string =>
    mimeType.startsWith('video/') ? VIDEO_DEFAULT_PROMPT : AUDIO_DEFAULT_PROMPT;

function logGeminiUsage(
    model: string,
    thinkingLevel: string,
    usageMetadata?: GeminiUsageMetadata,
): void {
    geminiLogger.info('Gemini API usage', {
        model,
        thinkingLevel,
        promptTokenCount: usageMetadata?.promptTokenCount,
        candidatesTokenCount: usageMetadata?.candidatesTokenCount,
        thoughtsTokenCount: usageMetadata?.thoughtsTokenCount,
        totalTokenCount: usageMetadata?.totalTokenCount,
    });
}

/** API のエラー文を利用者向けの文言に読み替える。該当しなければ元の文をそのまま返す */
function translateGeminiError(errorMessage: string, targetModel: string): string {
    if (errorMessage.includes('fetch') ||
        errorMessage.includes('network') ||
        errorMessage.includes('Failed to fetch') ||
        errorMessage.includes('NetworkError') ||
        errorMessage.toLowerCase().includes('offline')) {
        return 'ネットワークエラー: インターネット接続を確認してください。';
    }
    if (errorMessage.includes('API_KEY_INVALID') || errorMessage.includes('API key not valid')) {
        return 'Gemini APIキーが無効です。.env.localファイルを確認してください。';
    }
    if (errorMessage.includes('not found') || errorMessage.includes('404')) {
        return `指定されたモデルが見つかりません（${targetModel}）。Gemini APIキーとモデル名を確認してください。`;
    }
    if (errorMessage.includes('PERMISSION_DENIED')) {
        return 'Gemini APIへのアクセスが拒否されました。APIキーの権限を確認してください。';
    }
    if (errorMessage.includes('file too large') ||
        errorMessage.includes('too large') ||
        errorMessage.includes('payload')) {
        // S2-1: 「大きすぎます」で終わらせず、利用者が自分で打てる手を示す
        return describeInlineBudgetExceeded();
    }
    return errorMessage;
}

export class GeminiClient {
    private genAI: GoogleGenAI;
    private defaultModel: string;

    constructor(defaultModel: string = DEFAULT_GEMINI_MODEL) {
        const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;

        if (!apiKey) {
            throw new Error('NEXT_PUBLIC_GEMINI_API_KEY が設定されていません');
        }

        this.genAI = new GoogleGenAI({ apiKey });
        this.defaultModel = resolveGeminiModel(defaultModel);
    }

    /**
     * 動画ファイルから文字起こしと文書生成を行う（直接送信）
     * @param videoBlob 動画ファイルのBlob
     * @param fileName ファイル名
     * @param customPrompt カスタムプロンプト（オプション）
     * @param modelName 使用するGeminiモデル。未指定の場合は既定モデル。
     * @param thinkingLevel 思考レベル。未指定の場合は default。
     */
    async transcribeVideo(
        videoBlob: Blob,
        fileName: string,
        customPrompt?: string,
        modelName?: string,
        thinkingLevel: GeminiThinkingLevel = 'default',
    ): Promise<TranscriptionResult> {
        const targetModel = resolveGeminiModel(modelName ?? this.defaultModel);
        geminiLogger.info('transcribeVideo 開始', {
            fileName,
            mimeType: videoBlob.type,
            sizeInMB: (videoBlob.size / 1024 / 1024).toFixed(2),
            modelName: targetModel,
            hasCustomPrompt: Boolean(customPrompt),
            customPromptLength: customPrompt?.length,
        });

        let base64Video: string;
        try {
            base64Video = await this.blobToBase64(videoBlob);
        } catch (error) {
            geminiLogger.error('動画の直接送信でエラーが発生', error, { fileName, modelName: targetModel });
            return { success: false, error: error instanceof Error ? error.message : '不明なエラーが発生しました' };
        }

        return this.generateDocument(
            { kind: 'inline', base64Data: base64Video, mimeType: videoBlob.type || 'video/mp4' },
            fileName,
            customPrompt,
            modelName,
            thinkingLevel,
        );
    }

    /**
     * 音声ファイルから文字起こしと文書生成を行う
     * @param modelName 使用するGeminiモデル。未指定の場合は既定モデル。
     * @param thinkingLevel 思考レベル。未指定の場合は default。
     */
    async transcribeAudio(
        audioBlob: Blob,
        fileName: string,
        customPrompt?: string,
        modelName?: string,
        thinkingLevel: GeminiThinkingLevel = 'default',
    ): Promise<TranscriptionResult> {
        const targetModel = resolveGeminiModel(modelName ?? this.defaultModel);
        geminiLogger.info('transcribeAudio 開始', {
            fileName,
            mimeType: audioBlob.type,
            sizeInMB: (audioBlob.size / 1024 / 1024).toFixed(2),
            modelName: targetModel,
            hasCustomPrompt: Boolean(customPrompt),
            customPromptLength: customPrompt?.length,
        });

        let base64Audio: string;
        try {
            base64Audio = await this.blobToBase64(audioBlob);
        } catch (error) {
            geminiLogger.error('Gemini API呼び出しでエラーが発生', error, { fileName, modelName: targetModel });
            return { success: false, error: error instanceof Error ? error.message : '不明なエラーが発生しました' };
        }

        return this.generateDocument(
            { kind: 'inline', base64Data: base64Audio, mimeType: audioBlob.type || 'audio/mp3' },
            fileName,
            customPrompt,
            modelName,
            thinkingLevel,
        );
    }

    /**
     * BlobをBase64文字列に変換（1回だけ変換して複数プロンプトで共有するために公開）
     * 同一Blobを複数FileReaderで同時読みすると、大容量で空データになることがあるため、
     * 呼び出し元で1回だけ呼び、その結果を transcribeWithBase64 に渡すこと。
     */
    async getBase64(blob: Blob): Promise<string> {
        return this.blobToBase64(blob);
    }

    /**
     * S2-1: inline 予算を超えるメディアを Files API へアップロードし、generateContent から参照できる状態
     * (ACTIVE) になるまで待つ。1 ファイルにつき 1 回だけ呼び、全プロンプトで参照を共有すること。
     * アップロードしたファイルは 48 時間で自動削除されるが、生成が決着したら deleteUploadedMedia で消す。
     */
    async uploadMedia(
        blob: Blob,
        fileName: string,
        options: UploadMediaOptions = {},
    ): Promise<UploadedMediaRef> {
        const {
            signal,
            pollIntervalMs = FILES_API_ACTIVATION_POLL_MS,
            timeoutMs = FILES_API_ACTIVATION_TIMEOUT_MS,
        } = options;
        const mimeType = blob.type || 'audio/mpeg';

        geminiLogger.info('Files API へアップロードを開始', {
            fileName,
            mimeType,
            sizeInMB: (blob.size / 1024 / 1024).toFixed(2),
        });

        const uploaded = await this.genAI.files.upload({
            file: blob,
            config: {
                mimeType,
                displayName: fileName,
                ...(signal && { abortSignal: signal }),
            },
        });

        let current = uploaded;
        const deadline = Date.now() + timeoutMs;
        // state は SDK の FileState 列挙 ('PROCESSING' | 'ACTIVE' | 'FAILED') の文字列値。
        // 列挙オブジェクト経由にしないのは、SDK をモックしたテストで undefined 参照にならないため
        while ((current.state as string | undefined) === 'PROCESSING') {
            if (!current.name) {
                throw new Error('Files API がファイル名を返さなかったため、処理状態を確認できません。');
            }
            if (signal?.aborted) {
                throw signal.reason instanceof Error ? signal.reason : new Error('処理が中止されました。');
            }
            if (Date.now() >= deadline) {
                throw new Error('Files API でのファイル処理が時間内に完了しませんでした。しばらくしてから再試行してください。');
            }
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            current = await this.genAI.files.get({ name: current.name });
        }

        if ((current.state as string | undefined) === 'FAILED') {
            throw new Error(`Files API でのファイル処理に失敗しました: ${current.error?.message ?? '理由不明'}`);
        }
        if (!current.uri || !current.name) {
            throw new Error('Files API がファイルURIを返しませんでした。');
        }

        geminiLogger.info('Files API へのアップロードが完了', {
            fileName,
            name: current.name,
            state: current.state,
            sizeBytes: current.sizeBytes,
            expirationTime: current.expirationTime,
        });

        return { name: current.name, fileUri: current.uri, mimeType: current.mimeType ?? mimeType };
    }

    /** uploadMedia で上げたファイルを消す。失敗しても 48 時間で自動削除されるため、記録だけして例外にしない */
    async deleteUploadedMedia(name: string): Promise<void> {
        try {
            await this.genAI.files.delete({ name });
            geminiLogger.info('Files API のファイルを削除', { name });
        } catch (error) {
            geminiLogger.warn('Files API のファイル削除に失敗（48時間で自動削除される）', {
                name,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /**
     * 既にBase64化したメディアで文書生成を行う（getBase64 を1回だけ行い、複数プロンプトで共有する用途）
     * @param base64Data Base64文字列（data URLのプレフィックスなし）
     * @param mimeType 'video/mp4' または 'audio/mpeg' など
     * @param thinkingLevel 思考レベル。未指定の場合は default。
     * @param mediaBitrate 変換時のビットレート。予算超過の文言を「約N分」で出すために使う（任意）
     */
    async transcribeWithBase64(
        base64Data: string,
        mimeType: string,
        fileName: string,
        customPrompt?: string,
        modelName?: string,
        thinkingLevel: GeminiThinkingLevel = 'default',
        mediaBitrate?: string,
    ): Promise<TranscriptionResult> {
        return this.generateDocument(
            { kind: 'inline', base64Data, mimeType },
            fileName,
            customPrompt,
            modelName,
            thinkingLevel,
            mediaBitrate,
        );
    }

    /**
     * S2-1: Files API にアップロード済みのメディア (uploadMedia の戻り値) を参照して文書生成を行う。
     * inline 予算を超えるファイルはこちらを使う。
     */
    async transcribeWithFileUri(
        fileUri: string,
        mimeType: string,
        fileName: string,
        customPrompt?: string,
        modelName?: string,
        thinkingLevel: GeminiThinkingLevel = 'default',
    ): Promise<TranscriptionResult> {
        return this.generateDocument(
            { kind: 'file', fileUri, mimeType },
            fileName,
            customPrompt,
            modelName,
            thinkingLevel,
        );
    }

    /** generateContent の唯一の入口。inline は送る前に予算を検査し、超えていれば API を呼ばずに返す */
    private async generateDocument(
        media: MediaSource,
        fileName: string,
        customPrompt: string | undefined,
        modelName: string | undefined,
        thinkingLevel: GeminiThinkingLevel,
        mediaBitrate?: string,
    ): Promise<TranscriptionResult> {
        const targetModel = resolveGeminiModel(modelName ?? this.defaultModel);
        const resolvedThinkingLevel = resolveThinkingLevelForModel(thinkingLevel, targetModel);
        const usedThinkingLevel = resolvedThinkingLevel ?? 'unspecified';
        const { mimeType } = media;

        try {
            if (media.kind === 'inline' && (!media.base64Data || media.base64Data.length === 0)) {
                geminiLogger.error('Base64データが空のため送信をスキップ', { fileName, mimeType });
                return {
                    success: false,
                    error: '音声/動画データの読み取りに失敗しました。ファイルが大きい場合は再試行してください。',
                };
            }

            const prompt = customPrompt || defaultPromptFor(mimeType);

            if (media.kind === 'inline') {
                // S2-1: generateContent を呼ぶ前に inline 予算を検査する。超えていれば API に投げずに
                // 実行可能な文言で返す（API 側の「payload too large」は理由が伝わらず、課金にも時間にも無駄）
                const promptBytes = utf8ByteLength(prompt);
                if (selectMediaTransport(media.base64Data.length, promptBytes) !== 'inline') {
                    geminiLogger.error('inline 予算を超えるため generateContent を呼ばずに中止', undefined, {
                        fileName,
                        mimeType,
                        base64LengthChars: media.base64Data.length,
                        promptBytes,
                        budgetBytes: INLINE_REQUEST_BUDGET_BYTES,
                    });
                    return { success: false, error: describeInlineBudgetExceeded(mediaBitrate) };
                }

                geminiLogger.info('Gemini API へ送信（Base64共有）', {
                    fileName,
                    mimeType,
                    base64LengthChars: media.base64Data.length,
                    modelName: targetModel,
                    promptLength: prompt.length,
                });
            } else {
                geminiLogger.info('Gemini API へ送信（Files API 参照）', {
                    fileName,
                    mimeType,
                    fileUri: media.fileUri,
                    modelName: targetModel,
                    promptLength: prompt.length,
                });
            }

            const mediaPart = media.kind === 'inline'
                ? { inlineData: { mimeType, data: media.base64Data } }
                : { fileData: { fileUri: media.fileUri, mimeType } };

            const result = await this.genAI.models.generateContent({
                model: targetModel,
                ...(resolvedThinkingLevel && {
                    config: {
                        thinkingConfig: {
                            thinkingLevel: THINKING_LEVEL_ENUMS[resolvedThinkingLevel],
                        },
                    },
                }),
                contents: [
                    {
                        role: 'user',
                        parts: [
                            { text: prompt },
                            mediaPart,
                        ],
                    },
                ],
            });

            geminiLogger.info('generateContent のレスポンスを受信', { fileName });

            const text = result.text ?? '';

            logGeminiUsage(targetModel, usedThinkingLevel, result.usageMetadata);

            geminiLogger.info('文書生成が成功', {
                fileName,
                modelName: targetModel,
                generatedTextLength: text.length,
            });

            return {
                success: true,
                text,
                usedModel: targetModel,
                usedThinkingLevel,
            };
        } catch (error) {
            geminiLogger.error('Gemini API呼び出しでエラーが発生', error, {
                fileName,
                modelName: targetModel,
                mediaKind: media.kind,
            });

            let errorMessage = '不明なエラーが発生しました';
            if (error instanceof Error) {
                errorMessage = translateGeminiError(error.message, targetModel);
            }

            return {
                success: false,
                error: errorMessage,
            };
        }
    }

    /**
     * BlobをBase64文字列に変換
     */
    private async blobToBase64(blob: Blob): Promise<string> {
        geminiLogger.info('Base64変換を開始', {
            mimeType: blob.type,
            sizeInMB: (blob.size / 1024 / 1024).toFixed(2),
            sizeInBytes: blob.size,
        });
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64String = reader.result as string;
                // "data:audio/mpeg;base64," の部分を削除
                const base64Data = base64String?.split(',')[1] ?? '';
                if (!base64Data) {
                    geminiLogger.error('Base64変換結果が空です', { blobSize: blob.size, mimeType: blob.type });
                    reject(new Error('音声/動画データの読み取りに失敗しました。'));
                    return;
                }
                geminiLogger.info('Base64変換が完了', {
                    base64LengthChars: base64Data.length,
                    estimatedEncodedSizeMB: (base64Data.length * 0.75 / 1024 / 1024).toFixed(2),
                });
                resolve(base64Data);
            };
            reader.onerror = (e) => {
                geminiLogger.error('Base64変換でエラーが発生', e);
                reject(e);
            };
            reader.readAsDataURL(blob);
        });
    }
}
