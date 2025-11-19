import { WebCodecsAudioExtractor, AudioExtractionResult, AudioExtractionProgress } from './webcodecsAudioExtractor';
import { VideoConverter } from './ffmpeg';
import { createLogger } from './logger';

const audioExtractorLogger = createLogger('audioExtractor');

/**
 * 動画から音声を抽出する統合インターフェース
 * WebCodecs APIが利用可能な場合はそれを使用し、
 * そうでない場合はFFmpeg WASMにフォールバック
 */
export class AudioExtractor {
    /**
     * 動画ファイルから音声を抽出
     */
    static async extractAudio(
        videoFile: File,
        options?: {
            outputFormat?: 'aac' | 'opus' | 'wav' | 'mp3';
            bitrate?: number;
            sampleRate?: number;
            onProgress?: (progress: AudioExtractionProgress) => void;
            ffmpegConverter?: VideoConverter;
        }
    ): Promise<AudioExtractionResult> {
        const {
            outputFormat = 'aac',
            bitrate = 128000,
            sampleRate = 44100,
            onProgress,
            ffmpegConverter,
        } = options || {};

        // WebCodecs APIがサポートされているか確認
        if (WebCodecsAudioExtractor.isSupported()) {
            audioExtractorLogger.info('WebCodecs APIを使用して音声抽出を開始', {
                fileName: videoFile.name,
            });

            try {
                const extractor = new WebCodecsAudioExtractor();
                return await extractor.extractAudio(videoFile, {
                    outputFormat: outputFormat === 'mp3' ? 'aac' : outputFormat,
                    bitrate,
                    sampleRate,
                    onProgress,
                });
            } catch (error) {
                audioExtractorLogger.warn('WebCodecs APIでの抽出に失敗、FFmpeg WASMにフォールバック', error);
                // フォールバック処理へ
            }
        } else {
            audioExtractorLogger.info('WebCodecs APIがサポートされていないため、FFmpeg WASMを使用', {
                fileName: videoFile.name,
            });
        }

        // FFmpeg WASMにフォールバック
        if (!ffmpegConverter) {
            return {
                success: false,
                error: 'FFmpeg WASMコンバーターが提供されていません',
            };
        }

        try {
            audioExtractorLogger.info('FFmpeg WASMを使用して音声抽出を開始', {
                fileName: videoFile.name,
            });

            const result = await ffmpegConverter.convertToMp3(videoFile, {
                bitrate: `${Math.floor(bitrate / 1000)}k`,
                sampleRate,
                onProgress: onProgress
                    ? (progress) => {
                          onProgress({
                              decodedBytes: 0,
                              totalBytes: videoFile.size,
                              percentage: progress.ratio * 100,
                          });
                      }
                    : undefined,
            });

            if (result.success && result.outputBlob) {
                return {
                    success: true,
                    audioBlob: result.outputBlob,
                    mimeType: 'audio/mpeg',
                };
            } else {
                return {
                    success: false,
                    error: result.error || 'FFmpeg WASMでの変換に失敗しました',
                };
            }
        } catch (error) {
            audioExtractorLogger.error('FFmpeg WASMでの抽出エラー', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : '不明なエラーが発生しました',
            };
        }
    }

    /**
     * WebCodecs APIがサポートされているか確認
     */
    static isWebCodecsSupported(): boolean {
        return WebCodecsAudioExtractor.isSupported();
    }
}

