import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';

export interface TranscriptionResult {
    success: boolean;
    text?: string;
    error?: string;
}

export class GeminiClient {
    private genAI: GoogleGenerativeAI;
    private model: GenerativeModel;

    constructor() {
        const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;

        if (!apiKey) {
            throw new Error('NEXT_PUBLIC_GEMINI_API_KEY が設定されていません');
        }

        this.genAI = new GoogleGenerativeAI(apiKey);
        // Gemini 2.5 Flash（音声・動画対応、高速・効率的）を使用
        this.model = this.genAI.getGenerativeModel({
            model: 'gemini-2.5-flash'
        });
    }

    /**
     * 音声ファイルから文字起こしと文書生成を行う
     */
    async transcribeAudio(
        audioBlob: Blob,
        fileName: string,
        customPrompt?: string
    ): Promise<TranscriptionResult> {
        try {
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

            // Gemini APIにリクエスト
            const result = await this.model.generateContent([
                { text: prompt },
                {
                    inlineData: {
                        mimeType: 'audio/mp3',
                        data: base64Audio,
                    },
                },
            ]);

            const response = await result.response;
            const text = response.text();

            return {
                success: true,
                text,
            };
        } catch (error) {
            console.error('Gemini API エラー:', error);

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
                    errorMessage = '指定されたモデルが見つかりません。Gemini APIキーが正しく設定されているか確認してください。';
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
     * BlobをBase64文字列に変換
     */
    private async blobToBase64(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64String = reader.result as string;
                // "data:audio/mpeg;base64," の部分を削除
                const base64Data = base64String.split(',')[1];
                resolve(base64Data);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }
}

