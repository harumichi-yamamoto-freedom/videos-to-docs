import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { DEFAULT_GEMINI_MODEL } from '../constants/geminiModels';
import { createLogger } from './logger';

const geminiLogger = createLogger('gemini');

export interface TranscriptionResult {
    success: boolean;
    text?: string;
    error?: string;
}

export class GeminiClient {
    private genAI: GoogleGenerativeAI;
    private modelCache = new Map<string, GenerativeModel>();
    private defaultModel: string;

    constructor(defaultModel: string = DEFAULT_GEMINI_MODEL) {
        const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;

        if (!apiKey) {
            throw new Error('NEXT_PUBLIC_GEMINI_API_KEY が設定されていません');
        }

        this.genAI = new GoogleGenerativeAI(apiKey);
        this.defaultModel = defaultModel;
    }

    private getModelInstance(modelName?: string): GenerativeModel {
        const targetModel = (modelName || this.defaultModel || DEFAULT_GEMINI_MODEL).trim();
        if (!this.modelCache.has(targetModel)) {
            geminiLogger.info('モデルインスタンスを新規作成', { targetModel });
            this.modelCache.set(
                targetModel,
                this.genAI.getGenerativeModel({ model: targetModel })
            );
        } else {
            geminiLogger.info('モデルインスタンスをキャッシュから取得', { targetModel });
        }
        return this.modelCache.get(targetModel)!;
    }

    /**
     * 動画ファイルから文字起こしと文書生成を行う（直接送信）
     * @param videoBlob 動画ファイルのBlob
     * @param fileName ファイル名
     * @param customPrompt カスタムプロンプト（オプション）
     * @param modelName 使用するGeminiモデル。未指定の場合は既定モデル。
     */
    async transcribeVideo(
        videoBlob: Blob,
        fileName: string,
        customPrompt?: string,
        modelName?: string
    ): Promise<TranscriptionResult> {
        try {
            geminiLogger.info('transcribeVideo 開始', {
                fileName,
                mimeType: videoBlob.type,
                sizeInMB: (videoBlob.size / 1024 / 1024).toFixed(2),
                modelName: modelName || this.defaultModel,
                hasCustomPrompt: Boolean(customPrompt),
                customPromptLength: customPrompt?.length,
            });

            // BlobをBase64に変換
            const base64Video = await this.blobToBase64(videoBlob);

            // プロンプトの作成（カスタムプロンプトがあればそれを使用）
            const prompt = customPrompt || `
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

            // BlobのmimeTypeを取得（デフォルトはvideo/mp4）
            const mimeType = videoBlob.type || 'video/mp4';

            geminiLogger.info('Gemini API へ動画を送信', {
                fileName,
                mimeType,
                sizeInMB: (videoBlob.size / 1024 / 1024).toFixed(2),
                modelName: modelName || this.defaultModel,
                promptLength: prompt.length,
            });

            // Gemini APIにリクエスト
            const model = this.getModelInstance(modelName);
            const result = await model.generateContent([
                { text: prompt },
                {
                    inlineData: {
                        mimeType: mimeType,
                        data: base64Video,
                    },
                },
            ]);

            geminiLogger.info('generateContent のレスポンスを受信', { fileName });

            const response = result.response;
            const text = response.text();

            geminiLogger.info('動画の直接送信による文書生成が成功', {
                fileName,
                modelName: modelName || this.defaultModel,
                generatedTextLength: text.length,
            });

            return {
                success: true,
                text,
            };
        } catch (error) {
            geminiLogger.error('動画の直接送信でエラーが発生', error, { fileName, modelName });

            // より詳細なエラー情報を返す
            let errorMessage = '不明なエラーが発生しました';
            if (error instanceof Error) {
                errorMessage = error.message;

                // ネットワークエラーチェック
                if (errorMessage.includes('fetch') ||
                    errorMessage.includes('network') ||
                    errorMessage.includes('Failed to fetch') ||
                    errorMessage.includes('NetworkError') ||
                    errorMessage.toLowerCase().includes('offline')) {
                    errorMessage = 'ネットワークエラー: インターネット接続を確認してください。';
                }
                // APIキーのエラーチェック
                else if (errorMessage.includes('API_KEY_INVALID') || errorMessage.includes('API key not valid')) {
                    errorMessage = 'Gemini APIキーが無効です。.env.localファイルを確認してください。';
                } else if (errorMessage.includes('not found') || errorMessage.includes('404')) {
                    errorMessage = `指定されたモデルが見つかりません（${modelName || this.defaultModel}）。Gemini APIキーとモデル名を確認してください。`;
                } else if (errorMessage.includes('PERMISSION_DENIED')) {
                    errorMessage = 'Gemini APIへのアクセスが拒否されました。APIキーの権限を確認してください。';
                } else if (errorMessage.includes('file too large') || errorMessage.includes('payload')) {
                    errorMessage = '動画ファイルが大きすぎます。より小さいファイルを使用してください。';
                }
            }

            return {
                success: false,
                error: errorMessage,
            };
        }
    }

    /**
     * 音声ファイルから文字起こしと文書生成を行う
     * @param modelName 使用するGeminiモデル。未指定の場合は既定モデル。
     */
    async transcribeAudio(
        audioBlob: Blob,
        fileName: string,
        customPrompt?: string,
        modelName?: string
    ): Promise<TranscriptionResult> {
        try {
            geminiLogger.info('transcribeAudio 開始', {
                fileName,
                mimeType: audioBlob.type,
                sizeInMB: (audioBlob.size / 1024 / 1024).toFixed(2),
                modelName: modelName || this.defaultModel,
                hasCustomPrompt: Boolean(customPrompt),
                customPromptLength: customPrompt?.length,
            });

            // BlobをBase64に変換
            const base64Audio = await this.blobToBase64(audioBlob);

            // プロンプトの作成（カスタムプロンプトがあればそれを使用）
            const prompt = customPrompt || `
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

            // BlobのmimeTypeを取得（デフォルトはaudio/mp3）
            const mimeType = audioBlob.type || 'audio/mp3';

            geminiLogger.info('Gemini API へ音声を送信', {
                fileName,
                mimeType,
                sizeInMB: (audioBlob.size / 1024 / 1024).toFixed(2),
                modelName: modelName || this.defaultModel,
                promptLength: prompt.length,
            });

            // Gemini APIにリクエスト
            const model = this.getModelInstance(modelName);
            const result = await model.generateContent([
                { text: prompt },
                {
                    inlineData: {
                        mimeType: mimeType,
                        data: base64Audio,
                    },
                },
            ]);

            geminiLogger.info('generateContent のレスポンスを受信', { fileName });

            const response = result.response;
            const text = response.text();

            geminiLogger.info('音声の文書生成が成功', {
                fileName,
                modelName: modelName || this.defaultModel,
                generatedTextLength: text.length,
            });

            return {
                success: true,
                text,
            };
        } catch (error) {
            geminiLogger.error('Gemini API呼び出しでエラーが発生', error, { fileName, modelName });

            // より詳細なエラー情報を返す
            let errorMessage = '不明なエラーが発生しました';
            if (error instanceof Error) {
                errorMessage = error.message;

                // ネットワークエラーチェック
                if (errorMessage.includes('fetch') ||
                    errorMessage.includes('network') ||
                    errorMessage.includes('Failed to fetch') ||
                    errorMessage.includes('NetworkError') ||
                    errorMessage.toLowerCase().includes('offline')) {
                    errorMessage = 'ネットワークエラー: インターネット接続を確認してください。';
                }
                // APIキーのエラーチェック
                else if (errorMessage.includes('API_KEY_INVALID') || errorMessage.includes('API key not valid')) {
                    errorMessage = 'Gemini APIキーが無効です。.env.localファイルを確認してください。';
                } else if (errorMessage.includes('not found') || errorMessage.includes('404')) {
                    errorMessage = `指定されたモデルが見つかりません（${modelName || this.defaultModel}）。Gemini APIキーとモデル名を確認してください。`;
                } else if (errorMessage.includes('PERMISSION_DENIED')) {
                    errorMessage = 'Gemini APIへのアクセスが拒否されました。APIキーの権限を確認してください。';
                }
            }

            return {
                success: false,
                error: errorMessage,
            };
        }
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
     * 既にBase64化したメディアで文書生成を行う（getBase64 を1回だけ行い、複数プロンプトで共有する用途）
     * @param base64Data Base64文字列（data URLのプレフィックスなし）
     * @param mimeType 'video/mp4' または 'audio/mpeg' など
     */
    async transcribeWithBase64(
        base64Data: string,
        mimeType: string,
        fileName: string,
        customPrompt?: string,
        modelName?: string
    ): Promise<TranscriptionResult> {
        try {
            if (!base64Data || base64Data.length === 0) {
                geminiLogger.error('Base64データが空のため送信をスキップ', { fileName, mimeType });
                return {
                    success: false,
                    error: '音声/動画データの読み取りに失敗しました。ファイルが大きい場合は再試行してください。',
                };
            }

            const defaultPrompt = mimeType.startsWith('video/')
                ? `
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
`.trim()
                : `
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

            const prompt = customPrompt || defaultPrompt;

            geminiLogger.info('Gemini API へ送信（Base64共有）', {
                fileName,
                mimeType,
                base64LengthChars: base64Data.length,
                modelName: modelName || this.defaultModel,
                promptLength: prompt.length,
            });

            const model = this.getModelInstance(modelName);
            const result = await model.generateContent([
                { text: prompt },
                {
                    inlineData: {
                        mimeType: mimeType,
                        data: base64Data,
                    },
                },
            ]);

            geminiLogger.info('generateContent のレスポンスを受信', { fileName });

            const response = result.response;
            const text = response.text();

            geminiLogger.info('文書生成が成功', {
                fileName,
                modelName: modelName || this.defaultModel,
                generatedTextLength: text.length,
            });

            return {
                success: true,
                text,
            };
        } catch (error) {
            geminiLogger.error('Gemini API呼び出しでエラーが発生', error, { fileName, modelName });

            let errorMessage = '不明なエラーが発生しました';
            if (error instanceof Error) {
                errorMessage = error.message;
                if (errorMessage.includes('fetch') || errorMessage.includes('network') || errorMessage.includes('Failed to fetch') || errorMessage.includes('NetworkError') || errorMessage.toLowerCase().includes('offline')) {
                    errorMessage = 'ネットワークエラー: インターネット接続を確認してください。';
                } else if (errorMessage.includes('API_KEY_INVALID') || errorMessage.includes('API key not valid')) {
                    errorMessage = 'Gemini APIキーが無効です。.env.localファイルを確認してください。';
                } else if (errorMessage.includes('not found') || errorMessage.includes('404')) {
                    errorMessage = `指定されたモデルが見つかりません（${modelName || this.defaultModel}）。Gemini APIキーとモデル名を確認してください。`;
                } else if (errorMessage.includes('PERMISSION_DENIED')) {
                    errorMessage = 'Gemini APIへのアクセスが拒否されました。APIキーの権限を確認してください。';
                } else if (errorMessage.includes('file too large') || errorMessage.includes('payload')) {
                    errorMessage = '動画/音声ファイルが大きすぎます。より小さいファイルを使用してください。';
                }
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

