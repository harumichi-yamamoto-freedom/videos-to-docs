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

export interface SegmentConversionResult {
    success: boolean;
    segmentIndex: number;
    startTime: number;
    endTime: number;
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

    /**
     * 動画の長さ（秒）を取得
     */
    async getVideoDuration(videoFile: File): Promise<number> {
        if (!this.isLoaded) {
            await this.load();
        }

        const inputFileName = `probe_${Date.now()}.${videoFile.name.split('.').pop()}`;

        try {
            await this.ffmpeg.writeFile(inputFileName, await fetchFile(videoFile));

            // FFmpegのログを収集
            let duration = 0;
            const logHandler = ({ message }: { message: string }) => {
                // "Duration: 00:01:23.45" のような形式を探す
                const durationMatch = message.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
                if (durationMatch) {
                    const hours = parseInt(durationMatch[1]);
                    const minutes = parseInt(durationMatch[2]);
                    const seconds = parseInt(durationMatch[3]);
                    duration = hours * 3600 + minutes * 60 + seconds;
                }
            };

            this.ffmpeg.on('log', logHandler);

            try {
                // -i オプションで動画情報を取得（エラーになるが、ログに情報が出力される）
                await this.ffmpeg.exec(['-i', inputFileName]);
            } catch {
                // このコマンドはエラーになるのが正常（出力ファイルを指定していないため）
            } finally {
                this.ffmpeg.off('log', logHandler);
            }

            // クリーンアップ
            try {
                await this.ffmpeg.deleteFile(inputFileName);
            } catch {
                // 削除エラーは無視
            }

            if (duration === 0) {
                throw new Error('動画の長さを取得できませんでした');
            }

            return duration;
        } catch (error) {
            console.error('動画長さ取得エラー:', error);
            throw error;
        }
    }

    /**
     * 動画の指定区間を音声に変換
     */
    async convertSegmentToMp3(
        videoFile: File,
        startTime: number,
        endTime: number,
        segmentIndex: number,
        options: {
            bitrate?: string;
            sampleRate?: number;
            onProgress?: (progress: ConversionProgress) => void;
        } = {}
    ): Promise<SegmentConversionResult> {
        if (!this.isLoaded) {
            await this.load();
        }

        const { bitrate = '192k', sampleRate = 44100, onProgress } = options;

        const inputFileName = `input_seg${segmentIndex}_${Date.now()}.${videoFile.name.split('.').pop()}`;
        const outputFileName = `output_seg${segmentIndex}_${Date.now()}.mp3`;

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
                // 区間を指定してMP3に変換
                await this.ffmpeg.exec([
                    '-ss', startTime.toString(),
                    '-to', endTime.toString(),
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
            const uint8Array = new Uint8Array(data as Uint8Array);
            const outputBlob = new Blob([uint8Array], { type: 'audio/mpeg' });

            // 一時ファイルを削除
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
                segmentIndex,
                startTime,
                endTime,
                outputBlob
            };
        } catch (error) {
            console.error(`区間${segmentIndex}の変換エラー:`, error);

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
                segmentIndex,
                startTime,
                endTime,
                error: error instanceof Error ? error.message : '不明なエラーが発生しました'
            };
        }
    }

    /**
     * 複数の音声セグメントを1つのファイルに結合
     */
    async concatenateAudioSegments(segments: Blob[]): Promise<ConversionResult> {
        if (!this.isLoaded) {
            await this.load();
        }

        if (segments.length === 0) {
            return {
                success: false,
                error: '結合する音声セグメントがありません'
            };
        }

        // セグメントが1つだけの場合は結合不要
        if (segments.length === 1) {
            return {
                success: true,
                outputBlob: segments[0]
            };
        }

        const timestamp = Date.now();
        const concatListFileName = `concat_list_${timestamp}.txt`;
        const outputFileName = `output_concat_${timestamp}.mp3`;

        try {
            // セグメントをFFmpegに書き込み、concatリストを作成
            const fileList: string[] = [];
            for (let i = 0; i < segments.length; i++) {
                const segmentFileName = `segment_${i}_${timestamp}.mp3`;
                const segmentData = new Uint8Array(await segments[i].arrayBuffer());
                await this.ffmpeg.writeFile(segmentFileName, segmentData);
                fileList.push(`file '${segmentFileName}'`);
            }

            // concat用のテキストファイルを作成
            const concatListContent = fileList.join('\n');
            await this.ffmpeg.writeFile(
                concatListFileName,
                new TextEncoder().encode(concatListContent)
            );

            // FFmpegのconcatプロトコルで結合
            await this.ffmpeg.exec([
                '-f', 'concat',
                '-safe', '0',
                '-i', concatListFileName,
                '-c', 'copy',
                '-y',
                outputFileName
            ]);

            // 出力ファイルを読み取り
            const data = await this.ffmpeg.readFile(outputFileName);
            const uint8Array = new Uint8Array(data as Uint8Array);
            const outputBlob = new Blob([uint8Array], { type: 'audio/mpeg' });

            // 一時ファイルを削除
            try {
                await this.ffmpeg.deleteFile(concatListFileName);
                await this.ffmpeg.deleteFile(outputFileName);
                for (let i = 0; i < segments.length; i++) {
                    await this.ffmpeg.deleteFile(`segment_${i}_${timestamp}.mp3`);
                }
            } catch {
                // 削除エラーは無視
            }

            return {
                success: true,
                outputBlob
            };
        } catch (error) {
            console.error('音声結合エラー:', error);

            // エラー時もクリーンアップを試みる
            try {
                await this.ffmpeg.deleteFile(concatListFileName);
                await this.ffmpeg.deleteFile(outputFileName);
                for (let i = 0; i < segments.length; i++) {
                    await this.ffmpeg.deleteFile(`segment_${i}_${timestamp}.mp3`);
                }
            } catch {
                // 削除エラーは無視
            }

            return {
                success: false,
                error: error instanceof Error ? error.message : '音声結合に失敗しました'
            };
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
