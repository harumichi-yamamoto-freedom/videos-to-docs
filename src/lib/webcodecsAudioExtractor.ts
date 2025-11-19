import { createFile, type ISOFile, type Movie, type Track, type Sample } from 'mp4box';
import { createLogger } from './logger';

const webcodecsLogger = createLogger('webcodecs');

export interface AudioExtractionProgress {
    decodedBytes: number;
    totalBytes: number;
    percentage: number;
    currentTime?: number;
    duration?: number;
}

export interface AudioExtractionResult {
    success: boolean;
    audioBlob?: Blob;
    mimeType?: string;
    error?: string;
}

// MP4Boxの型拡張
declare global {
    interface ArrayBuffer {
        fileStart?: number;
    }
}

/**
 * WebCodecs APIを使用して動画から音声を抽出するクラス
 */
export class WebCodecsAudioExtractor {
    /**
     * ブラウザがWebCodecs APIをサポートしているか確認
     */
    static isSupported(): boolean {
        if (typeof window === 'undefined') {
            return false;
        }

        return (
            'AudioDecoder' in window &&
            'AudioEncoder' in window &&
            'VideoDecoder' in window &&
            typeof AudioDecoder !== 'undefined' &&
            typeof AudioEncoder !== 'undefined'
        );
    }

    /**
     * 動画ファイルから音声を抽出
     */
    async extractAudio(
        videoFile: File,
        options?: {
            outputFormat?: 'aac' | 'opus' | 'wav';
            bitrate?: number;
            sampleRate?: number;
            onProgress?: (progress: AudioExtractionProgress) => void;
        }
    ): Promise<AudioExtractionResult> {
        const {
            outputFormat = 'aac',
            bitrate = 128000,
            sampleRate = 44100,
            onProgress,
        } = options || {};

        try {
            webcodecsLogger.info('音声抽出開始', {
                fileName: videoFile.name,
                fileSize: videoFile.size,
                outputFormat,
                bitrate,
                sampleRate,
            });

            // MP4Boxでファイルを解析
            const mp4File = await this.parseMP4File(videoFile, onProgress);

            // 音声トラックを取得
            const audioTrack = this.getAudioTrack(mp4File);
            if (!audioTrack) {
                throw new Error('この動画には音声トラックが含まれていません');
            }

            webcodecsLogger.info('音声トラック取得完了', {
                trackId: audioTrack.id,
                codec: audioTrack.codec,
                nb_samples: audioTrack.nb_samples,
                sampleRate: audioTrack.audio?.sample_rate,
                channels: audioTrack.audio?.channel_count,
            });

            // コーデック情報を取得
            const codecConfig = this.getCodecConfig(mp4File, audioTrack);
            if (!codecConfig) {
                throw new Error('音声コーデック情報を取得できませんでした');
            }

            webcodecsLogger.info('コーデック設定取得完了', {
                codec: codecConfig.codec,
                sampleRate: codecConfig.sampleRate,
                numberOfChannels: codecConfig.numberOfChannels,
                hasDescription: !!codecConfig.description,
            });

            // 音声サンプルを処理するための配列
            const audioBuffers: AudioBuffer[] = [];
            const encodedChunks: EncodedAudioChunk[] = [];

            // AudioEncoderを先に初期化（必要に応じて）
            let audioEncoder: AudioEncoder | null = null;
            if (outputFormat === 'aac' || outputFormat === 'opus') {
                webcodecsLogger.info('AudioEncoder作成開始', { outputFormat, bitrate, sampleRate: codecConfig.sampleRate });
                audioEncoder = await this.createAudioEncoderWithHandler(
                    outputFormat,
                    bitrate,
                    codecConfig.sampleRate,
                    codecConfig.numberOfChannels,
                    encodedChunks
                );
                webcodecsLogger.info('AudioEncoder作成完了');
            }

            // AudioDecoderを初期化（出力ハンドラーを設定）
            webcodecsLogger.info('AudioDecoder作成開始', { codec: codecConfig.codec });
            const audioDecoder = await this.createAudioDecoderWithHandler(
                codecConfig,
                audioEncoder,
                audioBuffers,
                encodedChunks,
                onProgress,
                audioTrack.nb_samples,
                videoFile.size
            );
            webcodecsLogger.info('AudioDecoder作成完了');

            // 音声サンプルを処理
            webcodecsLogger.info('音声サンプル処理開始', {
                totalSamples: audioTrack.nb_samples,
                trackId: audioTrack.id,
            });
            await this.processAudioSamples(
                mp4File,
                audioTrack,
                audioDecoder,
                audioEncoder,
                onProgress,
                videoFile.size
            );
            webcodecsLogger.info('音声サンプル処理完了', {
                audioBuffersCount: audioBuffers.length,
                encodedChunksCount: encodedChunks.length,
            });

            // クリーンアップ
            audioDecoder.close();
            if (audioEncoder) {
                audioEncoder.close();
            }

            // 出力Blobを生成
            let audioBlob: Blob;
            let mimeType: string;

            if (outputFormat === 'wav') {
                // AudioBufferをWAVに変換
                audioBlob = this.audioBuffersToWav(audioBuffers, sampleRate);
                mimeType = 'audio/wav';
            } else if (outputFormat === 'aac') {
                // エンコード済みチャンクを結合
                audioBlob = this.encodedChunksToBlob(encodedChunks, 'audio/mp4');
                mimeType = 'audio/mp4';
            } else {
                // Opus
                audioBlob = this.encodedChunksToBlob(encodedChunks, 'audio/webm');
                mimeType = 'audio/webm';
            }

            webcodecsLogger.info('音声抽出完了', {
                fileName: videoFile.name,
                blobSize: audioBlob.size,
                mimeType,
            });

            return {
                success: true,
                audioBlob,
                mimeType,
            };
        } catch (error) {
            webcodecsLogger.error('音声抽出エラー', error, {
                fileName: videoFile.name,
            });

            return {
                success: false,
                error: error instanceof Error ? error.message : '不明なエラーが発生しました',
            };
        }
    }

    /**
     * MP4ファイルを解析
     */
    private async parseMP4File(
        videoFile: File,
        onProgress?: (progress: AudioExtractionProgress) => void
    ): Promise<ISOFile> {
        return new Promise((resolve, reject) => {
            const file = createFile();
            let loadedBytes = 0;
            let isReady = false;

            file.onReady = (info: Movie) => {
                webcodecsLogger.info('MP4解析完了', { info });
                isReady = true;
                resolve(file);
            };

            file.onError = (error: string) => {
                webcodecsLogger.error('MP4解析エラー', new Error(error));
                reject(new Error(`MP4解析エラー: ${error}`));
            };

            // ファイルをチャンクで読み込み
            const reader = new FileReader();
            const chunkSize = 1024 * 1024; // 1MB chunks

            const readChunk = (offset: number) => {
                if (isReady) {
                    return; // 既に準備完了
                }

                const chunk = videoFile.slice(offset, offset + chunkSize);
                reader.readAsArrayBuffer(chunk);
            };

            reader.onload = (e) => {
                if (!e.target?.result) {
                    reject(new Error('ファイル読み込みエラー'));
                    return;
                }

                const buffer = e.target.result as ArrayBuffer;
                (buffer as ArrayBuffer & { fileStart?: number }).fileStart = loadedBytes;
                const nextBuffer = file.appendBuffer(buffer as any);
                loadedBytes += buffer.byteLength;

                // 進捗更新
                if (onProgress && !isReady) {
                    onProgress({
                        decodedBytes: loadedBytes,
                        totalBytes: videoFile.size,
                        percentage: (loadedBytes / videoFile.size) * 100,
                    });
                }

                if (nextBuffer && !isReady) {
                    readChunk(loadedBytes);
                } else if (!isReady) {
                    file.flush();
                }
            };

            reader.onerror = () => {
                reject(new Error('ファイル読み込みエラー'));
            };

            readChunk(0);
        });
    }

    /**
     * 音声トラックを取得
     */
    private getAudioTrack(file: ISOFile): Track | null {
        const info = file.getInfo();
        // audioTracks配列を優先的に使用
        if (info.audioTracks && info.audioTracks.length > 0) {
            return info.audioTracks[0] as Track;
        }

        // フォールバック: tracks配列から検索
        const tracks = info.tracks || [];
        const audioTrack = tracks.find(
            (track: Track) => track.type === 'audio'
        ) as Track | undefined;

        return audioTrack || null;
    }

    /**
     * コーデック設定を取得
     */
    private getCodecConfig(
        file: ISOFile,
        track: Track
    ): { codec: string; description?: BufferSource; sampleRate: number; numberOfChannels: number } | null {
        const codec = track.codec;
        if (!codec) {
            return null;
        }

        // コーデック文字列をWebCodecs形式に変換
        let webcodecsCodec = '';
        let description: BufferSource | undefined;

        if (codec.startsWith('mp4a')) {
            // AAC
            webcodecsCodec = 'mp4a.40.2'; // AAC-LC
            // descriptionを取得（esdsボックスから取得）
            try {
                // trakボックスを取得
                const trakBox = file.getBox('trak');
                if (trakBox) {
                    // mdia -> minf -> stbl -> stsd -> mp4a -> esds の順で取得
                    const mdiaBox = (trakBox as any).mdia;
                    if (mdiaBox) {
                        const minfBox = mdiaBox.minf;
                        if (minfBox) {
                            const stblBox = minfBox.stbl;
                            if (stblBox) {
                                const stsdBox = stblBox.stsd;
                                if (stsdBox && stsdBox.entries && stsdBox.entries.length > 0) {
                                    const mp4aEntry = stsdBox.entries[0];
                                    if (mp4aEntry && mp4aEntry.esds) {
                                        const esdsBox = mp4aEntry.esds;
                                        if (esdsBox && esdsBox.esd) {
                                            const esd = esdsBox.esd;
                                            if (esd && esd.decConfigDescr) {
                                                const decConfig = esd.decConfigDescr;
                                                if (decConfig && decConfig.decSpecificInfo) {
                                                    const decSpecificInfo = decConfig.decSpecificInfo;
                                                    if (decSpecificInfo && decSpecificInfo.data) {
                                                        description = decSpecificInfo.data as BufferSource;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (descError) {
                webcodecsLogger.warn('description取得エラー（無視）', {
                    error: descError instanceof Error ? descError.message : String(descError),
                });
                // descriptionがなくても動作する可能性があるため、エラーは無視
            }
        } else if (codec.startsWith('opus')) {
            webcodecsCodec = 'opus';
        } else if (codec.startsWith('ac-3')) {
            webcodecsCodec = 'ac-3';
        } else {
            webcodecsLogger.warn('未対応のコーデック', { codec });
            return null;
        }

        return {
            codec: webcodecsCodec,
            description,
            sampleRate: track.audio?.sample_rate || 44100,
            numberOfChannels: track.audio?.channel_count || 2,
        };
    }

    /**
     * AudioDecoderを作成（出力ハンドラー付き）
     */
    private async createAudioDecoderWithHandler(
        codecConfig: { codec: string; description?: BufferSource; sampleRate: number; numberOfChannels: number },
        encoder: AudioEncoder | null,
        audioBuffers: AudioBuffer[],
        encodedChunks: EncodedAudioChunk[],
        onProgress?: (progress: AudioExtractionProgress) => void,
        totalSamples?: number,
        totalBytes?: number
    ): Promise<AudioDecoder> {
        return new Promise((resolve, reject) => {
            let decoderOutputCount = 0;

            const decoder = new AudioDecoder({
                output: (audioData: AudioData) => {
                    decoderOutputCount++;

                    if (decoderOutputCount % 100 === 0) {
                        webcodecsLogger.info('AudioDecoder出力', {
                            count: decoderOutputCount,
                            frames: audioData.numberOfFrames,
                            channels: audioData.numberOfChannels,
                            sampleRate: audioData.sampleRate,
                        });
                    }

                    try {
                        if (encoder) {
                            // AudioEncoderでエンコード
                            encoder.encode(audioData);
                        } else {
                            // AudioBufferに変換して保存
                            const audioContext = new AudioContext({ sampleRate: audioData.sampleRate });
                            const audioBuffer = audioContext.createBuffer(
                                audioData.numberOfChannels,
                                audioData.numberOfFrames,
                                audioData.sampleRate
                            );

                            for (let i = 0; i < audioData.numberOfChannels; i++) {
                                const channelData = audioBuffer.getChannelData(i);
                                audioData.copyTo(channelData, { planeIndex: i });
                            }

                            audioBuffers.push(audioBuffer);
                        }

                        audioData.close();

                        // 進捗更新
                        if (onProgress && totalSamples && totalBytes) {
                            const progress = (decoderOutputCount / totalSamples) * 100;
                            onProgress({
                                decodedBytes: totalBytes * (progress / 100),
                                totalBytes,
                                percentage: Math.min(progress, 100),
                            });
                        }
                    } catch (outputError) {
                        webcodecsLogger.error('AudioDecoder出力処理エラー', outputError);
                    }
                },
                error: (error: Error) => {
                    webcodecsLogger.error('AudioDecoderエラー', error);
                    reject(error);
                },
            });

            try {
                const config: AudioDecoderConfig = {
                    codec: codecConfig.codec,
                    sampleRate: codecConfig.sampleRate,
                    numberOfChannels: codecConfig.numberOfChannels,
                };

                if (codecConfig.description) {
                    config.description = codecConfig.description;
                    webcodecsLogger.info('AudioDecoder設定にdescriptionを含める', {
                        descriptionSize: codecConfig.description.byteLength,
                    });
                }

                webcodecsLogger.info('AudioDecoder設定', {
                    codec: config.codec,
                    sampleRate: config.sampleRate,
                    numberOfChannels: config.numberOfChannels,
                    hasDescription: !!config.description,
                });

                decoder.configure(config);
                webcodecsLogger.info('AudioDecoder設定完了');
                resolve(decoder);
            } catch (error) {
                webcodecsLogger.error('AudioDecoder設定エラー', error);
                reject(error);
            }
        });
    }

    /**
     * AudioEncoderを作成（出力ハンドラー付き）
     */
    private async createAudioEncoderWithHandler(
        format: 'aac' | 'opus',
        bitrate: number,
        sampleRate: number,
        numberOfChannels: number,
        encodedChunks: EncodedAudioChunk[]
    ): Promise<AudioEncoder> {
        return new Promise((resolve, reject) => {
            const codec = format === 'aac' ? 'mp4a.40.2' : 'opus';
            let encoderOutputCount = 0;

            const encoder = new AudioEncoder({
                output: (chunk: EncodedAudioChunk) => {
                    encoderOutputCount++;
                    encodedChunks.push(chunk);

                    if (encoderOutputCount % 100 === 0) {
                        webcodecsLogger.info('AudioEncoder出力', {
                            count: encoderOutputCount,
                            chunkSize: chunk.byteLength,
                            timestamp: chunk.timestamp,
                        });
                    }
                },
                error: (error: Error) => {
                    webcodecsLogger.error('AudioEncoderエラー', error);
                    reject(error);
                },
            });

            try {
                const config = {
                    codec,
                    sampleRate,
                    numberOfChannels,
                    bitrate,
                };

                webcodecsLogger.info('AudioEncoder設定', config);
                encoder.configure(config);
                webcodecsLogger.info('AudioEncoder設定完了');
                resolve(encoder);
            } catch (error) {
                webcodecsLogger.error('AudioEncoder設定エラー', error);
                reject(error);
            }
        });
    }

    /**
     * 音声サンプルを処理（getTrackSamplesInfoを使用する方法）
     */
    private async processAudioSamples(
        file: ISOFile,
        track: Track,
        decoder: AudioDecoder,
        encoder: AudioEncoder | null,
        onProgress?: (progress: AudioExtractionProgress) => void,
        totalBytes?: number
    ): Promise<void> {
        return new Promise(async (resolve, reject) => {
            try {
                const totalSamples = track.nb_samples;
                webcodecsLogger.info('サンプル情報取得開始', { trackId: track.id, totalSamples });

                // サンプル情報を取得
                const samplesInfo = file.getTrackSamplesInfo(track.id);
                webcodecsLogger.info('サンプル情報取得完了', { samplesCount: samplesInfo.length });

                if (samplesInfo.length === 0) {
                    reject(new Error('サンプル情報が取得できませんでした'));
                    return;
                }

                let processedSamples = 0;
                const batchSize = 100; // バッチ処理サイズ

                // バッチでサンプルを処理
                for (let i = 0; i < samplesInfo.length; i += batchSize) {
                    const batch = samplesInfo.slice(i, Math.min(i + batchSize, samplesInfo.length));

                    for (const sampleInfo of batch) {
                        try {
                            // サンプルデータを取得
                            const sample = file.getTrackSample(track.id, sampleInfo.number);

                            if (!sample || !sample.data) {
                                webcodecsLogger.warn('サンプルデータが取得できませんでした', {
                                    sampleNumber: sampleInfo.number,
                                });
                                continue;
                            }

                            const chunk = new EncodedAudioChunk({
                                type: sample.is_sync ? 'key' : 'delta',
                                timestamp: sample.cts,
                                duration: sample.duration,
                                data: sample.data,
                            });

                            decoder.decode(chunk);
                            processedSamples++;

                            // 進捗更新
                            if (onProgress && totalBytes) {
                                const progress = (processedSamples / totalSamples) * 100;
                                onProgress({
                                    decodedBytes: totalBytes * (progress / 100),
                                    totalBytes,
                                    percentage: Math.min(progress, 100),
                                });
                            }

                            // 定期的にログ出力
                            if (processedSamples % 1000 === 0) {
                                webcodecsLogger.info('サンプル処理中', {
                                    processedSamples,
                                    totalSamples,
                                    progress: ((processedSamples / totalSamples) * 100).toFixed(2) + '%',
                                });
                            }

                            // サンプルを解放（メモリ管理）
                            file.releaseUsedSamples(track.id, sampleInfo.number);
                        } catch (sampleError) {
                            webcodecsLogger.error('サンプル処理エラー', sampleError, {
                                sampleNumber: sampleInfo.number,
                            });
                            // エラーが発生しても続行
                        }
                    }

                    // バッチ処理の間に少し待機（UIブロックを防ぐ）
                    if (i + batchSize < samplesInfo.length) {
                        await new Promise(resolve => setTimeout(resolve, 0));
                    }
                }

                webcodecsLogger.info('すべてのサンプル処理完了、フラッシュ開始', {
                    processedSamples,
                    totalSamples,
                });

                // フラッシュ
                decoder.flush().then(() => {
                    webcodecsLogger.info('AudioDecoderフラッシュ完了');
                    if (encoder) {
                        encoder.flush().then(() => {
                            webcodecsLogger.info('AudioEncoderフラッシュ完了');
                            resolve();
                        }).catch((flushError) => {
                            webcodecsLogger.error('AudioEncoderフラッシュエラー', flushError);
                            reject(flushError);
                        });
                    } else {
                        resolve();
                    }
                }).catch((flushError) => {
                    webcodecsLogger.error('AudioDecoderフラッシュエラー', flushError);
                    reject(flushError);
                });
            } catch (error) {
                webcodecsLogger.error('サンプル処理エラー', error);
                reject(error);
            }
        });
    }

    /**
     * AudioBufferをWAV Blobに変換
     */
    private audioBuffersToWav(
        audioBuffers: AudioBuffer[],
        sampleRate: number
    ): Blob {
        // すべてのAudioBufferを結合
        const totalLength = audioBuffers.reduce(
            (sum, buffer) => sum + buffer.length,
            0
        );
        const numberOfChannels = audioBuffers[0]?.numberOfChannels || 2;

        const mergedBuffer = new AudioBuffer({
            length: totalLength,
            numberOfChannels,
            sampleRate,
        });

        let offset = 0;
        for (const buffer of audioBuffers) {
            for (let channel = 0; channel < numberOfChannels; channel++) {
                const channelData = buffer.getChannelData(channel);
                const mergedChannelData = mergedBuffer.getChannelData(channel);
                mergedChannelData.set(channelData, offset);
            }
            offset += buffer.length;
        }

        // WAVに変換
        return this.audioBufferToWav(mergedBuffer);
    }

    /**
     * AudioBufferをWAV Blobに変換
     */
    private audioBufferToWav(audioBuffer: AudioBuffer): Blob {
        const numberOfChannels = audioBuffer.numberOfChannels;
        const sampleRate = audioBuffer.sampleRate;
        const length = audioBuffer.length;

        const arrayBuffer = new ArrayBuffer(44 + length * numberOfChannels * 2);
        const view = new DataView(arrayBuffer);

        // WAVヘッダー
        const writeString = (offset: number, string: string) => {
            for (let i = 0; i < string.length; i++) {
                view.setUint8(offset + i, string.charCodeAt(i));
            }
        };

        writeString(0, 'RIFF');
        view.setUint32(4, 36 + length * numberOfChannels * 2, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, numberOfChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * numberOfChannels * 2, true);
        view.setUint16(32, numberOfChannels * 2, true);
        view.setUint16(34, 16, true);
        writeString(36, 'data');
        view.setUint32(40, length * numberOfChannels * 2, true);

        // 音声データ
        let offset = 44;
        for (let i = 0; i < length; i++) {
            for (let channel = 0; channel < numberOfChannels; channel++) {
                const sample = Math.max(
                    -1,
                    Math.min(1, audioBuffer.getChannelData(channel)[i])
                );
                view.setInt16(offset, sample * 0x7fff, true);
                offset += 2;
            }
        }

        return new Blob([arrayBuffer], { type: 'audio/wav' });
    }

    /**
     * エンコード済みチャンクをBlobに変換
     */
    private encodedChunksToBlob(
        chunks: EncodedAudioChunk[],
        mimeType: string
    ): Blob {
        const blobParts: BlobPart[] = [];

        for (const chunk of chunks) {
            const buffer = new ArrayBuffer(chunk.byteLength);
            chunk.copyTo(buffer);
            blobParts.push(buffer);
        }

        return new Blob(blobParts, { type: mimeType });
    }
}

