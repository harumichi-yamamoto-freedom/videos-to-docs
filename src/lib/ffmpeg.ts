import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

export interface ConversionProgress {
    ratio: number;
}

export interface ConversionResult {
    success: boolean;
    outputBlob?: Blob;
    error?: string;
}

export class VideoConverter {
    private ffmpeg: FFmpeg;
    private isLoaded = false;

    constructor() {
        this.ffmpeg = new FFmpeg();
    }

    async load(): Promise<void> {
        if (this.isLoaded) return;

        try {
            const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
            await this.ffmpeg.load({
                coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
                wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
            });
            this.isLoaded = true;
        } catch (error) {
            console.error('FFmpegの読み込みに失敗しました:', error);
            throw new Error('FFmpegの初期化に失敗しました');
        }
    }

    async convertToMp3(
        videoFile: File,
        options: {
            bitrate?: string;
            sampleRate?: number;
            onProgress?: (progress: ConversionProgress) => void;
        } = {}
    ): Promise<ConversionResult> {
        if (!this.isLoaded) {
            await this.load();
        }

        const { bitrate = '192k', sampleRate = 44100, onProgress } = options;

        const inputFileName = `input_${Date.now()}.${videoFile.name.split('.').pop()}`;
        const outputFileName = `output_${Date.now()}.mp3`;

        try {
            // ファイルをFFmpegに書き込み
            await this.ffmpeg.writeFile(inputFileName, await fetchFile(videoFile));

            // 進捗監視のハンドラーを定義
            const progressHandler = ({ progress }: { progress: number }) => {
                if (onProgress) {
                    onProgress({ ratio: progress });
                }
            };

            // 進捗監視の設定
            this.ffmpeg.on('progress', progressHandler);

            try {
                // MP3に変換
                await this.ffmpeg.exec([
                    '-i', inputFileName,
                    '-vn', // ビデオストリームを無効化
                    '-acodec', 'libmp3lame',
                    '-ab', bitrate,
                    '-ar', sampleRate.toString(),
                    '-y', // 出力ファイルを上書き
                    outputFileName
                ]);
            } finally {
                // 進捗監視を解除
                this.ffmpeg.off('progress', progressHandler);
            }

            // 出力ファイルを読み取り
            const data = await this.ffmpeg.readFile(outputFileName);
            // Uint8Arrayに変換してからBlobを作成
            const uint8Array = new Uint8Array(data as Uint8Array);
            const outputBlob = new Blob([uint8Array], { type: 'audio/mpeg' });

            // 一時ファイルを削除（エラーを無視）
            try {
                await this.ffmpeg.deleteFile(inputFileName);
            } catch {
                // 削除エラーは無視
            }
            try {
                await this.ffmpeg.deleteFile(outputFileName);
            } catch {
                // 削除エラーは無視
            }

            return {
                success: true,
                outputBlob
            };
        } catch (error) {
            console.error('変換エラー:', error);

            // エラー時もクリーンアップを試みる
            try {
                await this.ffmpeg.deleteFile(inputFileName);
            } catch {
                // 削除エラーは無視
            }
            try {
                await this.ffmpeg.deleteFile(outputFileName);
            } catch {
                // 削除エラーは無視
            }

            return {
                success: false,
                error: error instanceof Error ? error.message : '不明なエラーが発生しました'
            };
        }
    }

    async convertMultipleToMp3(
        videoFiles: File[],
        options: {
            bitrate?: string;
            sampleRate?: number;
            onProgress?: (fileIndex: number, progress: ConversionProgress) => void;
        } = {}
    ): Promise<ConversionResult[]> {
        const results: ConversionResult[] = [];

        for (let i = 0; i < videoFiles.length; i++) {
            const file = videoFiles[i];
            const result = await this.convertToMp3(file, {
                ...options,
                onProgress: (progress) => {
                    if (options.onProgress) {
                        options.onProgress(i, progress);
                    }
                }
            });
            results.push(result);
        }

        return results;
    }

    // サポートされている動画形式をチェック
    static isSupportedFormat(file: File): boolean {
        const supportedFormats = ['mp4', 'mov', 'avi', 'mkv', 'webm'];
        const extension = file.name.split('.').pop()?.toLowerCase();
        return extension ? supportedFormats.includes(extension) : false;
    }
}
