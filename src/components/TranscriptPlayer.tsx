'use client';

/**
 * P1: 文字起こし文書に従属する再生プレイヤー（設計 §6.5）。
 *
 * 🔴 この画面は「文字起こし専用画面」ではない。通常の文書詳細の下辺に貼り付く細い帯であり、
 *    音声が無い文書では null を返して 1px も描かない。既存文書の見た目を変えないことが第一条件。
 *
 * 本文（Markdown）側の時刻リンクとこの帯は別ファイルに分かれているため、両者はこのモジュールの
 * 小さなストアで繋ぐ。Provider を足すと lead 側の配線点が増えるので、
 * モジュール内シングルトン + useSyncExternalStore にした（同時に開く文書は常に 1 本）。
 *
 * 仕様 B3（要確認箇所）で足したもの:
 * - `audio`: 音声の可用性。`ready`（コントローラ接続）とは別に、URL の取得と音声要素のロード状態を持つ。
 *   要確認カードの「音声を再生」はこれが `'ready'` のときだけ押せる（押しても無反応なボタンを出さない）。
 * - `playbackBlocked`: ブラウザが再生を拒否した（自動再生ポリシー等）。再生済みの見た目にせず、案内を出す。
 * - `followPausedByJump`: 候補カードからの「本文の該当段落へ移動」で追従を一時的に止めている過渡状態。
 *   🔴 利用者の永続設定 `follow` とは別物で、`follow` を書き換えない（文書切替・再マウントで自動的に解ける）。
 */

import React, {
    useCallback,
    useEffect,
    useRef,
    useSyncExternalStore,
} from 'react';
import { Crosshair, Pause, Play } from 'lucide-react';
import { formatTimestamp } from '@/lib/transcriptMerge';

/**
 * 音声の可用性。
 * - `none`: 文字起こし UI が載っていない（通常の文書・切替直後）
 * - `loading`: URL の取得中、または音声要素がまだメタデータを読めていない
 * - `ready`: 音声要素が読めた（再生・シークできる）
 * - `unavailable`: 音声参照が無い／URL 取得失敗／音声要素のロード失敗（本文の確認・編集はできる）
 */
export type TranscriptAudioStatus = 'none' | 'loading' | 'ready' | 'unavailable';
export type TranscriptAudioUnavailableReason = 'no_audio' | 'url_failed' | 'media_failed';

export interface TranscriptPlaybackSnapshot {
    /** 現在の再生位置（秒） */
    currentSec: number;
    /** 総尺（秒）。読めていなければ 0 */
    durationSec: number;
    playing: boolean;
    /** 再生中の行へスクロール追従するか。利用者が止められる */
    follow: boolean;
    /** 音声付きのプレイヤーが実際に載っているか（コントローラの接続）。音声ロード成功の保証ではない */
    ready: boolean;
    /** 音声の可用性（URL 取得と音声要素のロード状態を含む） */
    audio: TranscriptAudioStatus;
    /** `audio === 'unavailable'` のときの理由。再試行の要否の判断に使う */
    audioReason: TranscriptAudioUnavailableReason | null;
    /** 直前の再生要求をブラウザが拒否した（自動再生の拒否）。再生が始まると解ける */
    playbackBlocked: boolean;
    /**
     * 候補ジャンプ（本文の該当段落へ移動）で追従を一時的に止めている。
     * 🔴 `follow`（利用者の永続設定）は書き換えない過渡状態。追従トグル・シーク・文書切替（attach の終了）・reset で解ける。
     */
    followPausedByJump: boolean;
}

/** 音声要素を持つ側（＝TranscriptPlayer）が登録する実操作 */
export interface TranscriptPlaybackController {
    seek: (sec: number) => void;
}

type Listener = () => void;

const INITIAL_SNAPSHOT: TranscriptPlaybackSnapshot = {
    currentSec: 0,
    durationSec: 0,
    playing: false,
    follow: true,
    ready: false,
    audio: 'none',
    audioReason: null,
    playbackBlocked: false,
    followPausedByJump: false,
};

const createTranscriptPlaybackStore = () => {
    let state: TranscriptPlaybackSnapshot = INITIAL_SNAPSHOT;
    let controller: TranscriptPlaybackController | null = null;
    const listeners = new Set<Listener>();

    const emit = (): void => {
        for (const listener of [...listeners]) listener();
    };

    const patch = (next: Partial<TranscriptPlaybackSnapshot>): void => {
        let changed = false;
        for (const key of Object.keys(next) as (keyof TranscriptPlaybackSnapshot)[]) {
            if (next[key] !== undefined && next[key] !== state[key]) changed = true;
        }
        if (!changed) return;
        state = { ...state, ...next };
        emit();
    };

    return {
        subscribe: (listener: Listener): (() => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot: (): TranscriptPlaybackSnapshot => state,
        patch,
        /**
         * 時刻リンクからの移動。
         * 🔴 音声が無い（＝プレイヤーが載っていない）ときは何も起こさない。
         *    リンクは読める文字として残るが、押しても文書は動かない。
         */
        seek: (sec: number): void => {
            if (!controller || !Number.isFinite(sec)) return;
            // 利用者が再生位置を動かした＝候補ジャンプの一時停止から追従へ復帰する
            patch({ currentSec: Math.max(0, sec), followPausedByJump: false });
            controller.seek(Math.max(0, sec));
        },
        /** 追従の入切（利用者の永続設定）。トグル操作は候補ジャンプの一時停止を必ず解く */
        setFollow: (follow: boolean): void => patch({ follow, followPausedByJump: false }),
        /**
         * 候補ジャンプ中の追従の一時停止（次の時刻更新でジャンプ先から引き戻さない）。
         * 🔴 `follow` は書き換えない。解除は setFollow / seek / attach の終了（文書切替・再マウント）/ reset。
         */
        pauseFollowForJump: (): void => patch({ followPausedByJump: true }),
        /** 音声の可用性を置く（URL の取得側とプレイヤーの両方から呼ぶ） */
        setAudio: (audio: TranscriptAudioStatus, reason: TranscriptAudioUnavailableReason | null = null): void =>
            patch({ audio, audioReason: audio === 'unavailable' ? reason : null }),
        /** 音声要素が読めた。`loading` からだけ進める（ロード失敗の後に届く suspend 等で戻さない） */
        markAudioReady: (): void => {
            if (state.audio !== 'loading') return;
            patch({ audio: 'ready', audioReason: null });
        },
        attach: (next: TranscriptPlaybackController): (() => void) => {
            controller = next;
            patch({ ready: true });
            return () => {
                if (controller !== next) return;
                controller = null;
                // 🔴 利用者の永続設定 `follow` だけを持ち越す。候補ジャンプの一時停止（followPausedByJump）は
                //    INITIAL 由来で false に戻る＝文書切替・再マウントで自動的に解ける
                state = { ...INITIAL_SNAPSHOT, follow: state.follow };
                emit();
            };
        },
        /** テスト用。状態と登録済みコントローラを初期状態へ戻す */
        reset: (): void => {
            controller = null;
            state = INITIAL_SNAPSHOT;
            emit();
        },
    };
};

export const transcriptPlayback = createTranscriptPlaybackStore();

/** 本文側（時刻リンク・行ハイライト）から再生状態を読む */
export const useTranscriptPlayback = (): TranscriptPlaybackSnapshot =>
    useSyncExternalStore(
        transcriptPlayback.subscribe,
        transcriptPlayback.getSnapshot,
        transcriptPlayback.getSnapshot,
    );

/**
 * スクロールの寄せ方。動きを減らす設定（prefers-reduced-motion）ではアニメーションを止める。
 * matchMedia の無い実行環境（jsdom・SSR）では従来どおり smooth。
 */
export const scrollBehaviorForMotion = (): ScrollBehavior => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'smooth';
    try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    } catch {
        return 'smooth';
    }
};

const safeDuration = (value: number | undefined): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/** 自動再生ポリシーによる拒否だけを「案内対象」にする。pause() による中断（AbortError）等は含めない */
const isNotAllowedError = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'NotAllowedError';

export interface TranscriptPlayerProps {
    /** 再生する音声の URL。無い文書では未指定になり、この帯ごと消える */
    audioUrl?: string | null;
    /** 総尺が分かっていれば渡す（metadata 読み込み前の表示に使う） */
    durationSec?: number;
    className?: string;
    /** 音声要素のロード失敗（URL は取れたが再生できない）。呼び出し側が帯を状態表示へ差し替える */
    onMediaError?: () => void;
}

/**
 * 文書の下辺に貼り付く細い帯。
 * sticky にしているのは「文書に従属させる」ため（fixed だと文書を離れて画面全体に居座る）。
 */
export function TranscriptPlayer({
    audioUrl,
    durationSec,
    className,
    onMediaError,
}: TranscriptPlayerProps): React.ReactElement | null {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    // play() の世代。文書切替（要素の張り替え・remount）や後続の play() で追い越された
    // 遅延結果を弾くために使う（Major1: 共有ストアへの誤った上書きを防ぐ）
    const playGenerationRef = useRef(0);
    const snapshot = useTranscriptPlayback();
    const hasAudio = typeof audioUrl === 'string' && audioUrl.trim() !== '';

    const play = useCallback((): void => {
        const element = audioRef.current;
        if (!element) return;
        // 🔴 この play() 呼び出しの世代と音声要素を捕捉する。文書を切り替える（＝プレイヤーが
        //    remount されて要素が張り替わる）と、遅れて届く resolve/reject は共有ストアへ書かない。
        //    そうしないと、前の文書の play() の遅延結果が別文書の再生状態を上書きしてしまう
        //    （B の playing が誤って false になる／A の NotAllowedError が B に再生拒否案内を出す）。
        const generation = (playGenerationRef.current += 1);
        const isCurrent = (): boolean =>
            audioRef.current === element && playGenerationRef.current === generation;
        try {
            const started: unknown = element.play();
            if (started && typeof (started as Promise<void>).then === 'function') {
                void (started as Promise<void>).then(
                    () => {
                        if (isCurrent()) transcriptPlayback.patch({ playing: true, playbackBlocked: false });
                    },
                    (error: unknown) => {
                        // 🔴 拒否されたのに「再生中」の見た目にしない。自動再生の拒否だけを案内する。
                        //    ただし現役の要素／世代でなければ（切替後）何も書かない。
                        if (!isCurrent()) return;
                        transcriptPlayback.patch(
                            isNotAllowedError(error)
                                ? { playing: false, playbackBlocked: true }
                                : { playing: false },
                        );
                    },
                );
            }
        } catch {
            // 音声要素を持たない実行環境。帯の状態表示だけ進める
        }
        // 楽観的な「再生中」表示も、現役の要素／世代のときだけ（切替直後の誤 true を防ぐ）
        if (isCurrent()) transcriptPlayback.patch({ playing: true });
    }, []);

    const pause = useCallback((): void => {
        const element = audioRef.current;
        try {
            element?.pause();
        } catch {
            // 同上
        }
        transcriptPlayback.patch({ playing: false });
    }, []);

    // 時刻リンクからの移動を受ける口。プレイヤーが居る間だけ登録される
    useEffect(() => {
        if (!hasAudio) return;
        transcriptPlayback.patch({ durationSec: safeDuration(durationSec) });
        // 音声要素のロード状態。メタデータが読めていれば ready、まだなら loading（要素のイベントで進める）
        const element = audioRef.current;
        transcriptPlayback.setAudio(element && element.readyState >= 1 ? 'ready' : 'loading');
        return transcriptPlayback.attach({
            seek: (sec: number) => {
                const element = audioRef.current;
                if (element) {
                    try {
                        element.currentTime = sec;
                    } catch {
                        // currentTime を持たない実行環境
                    }
                }
                play();
            },
        });
    }, [hasAudio, durationSec, play]);

    // 🔴 音声が無い文書では、存在ごと消える（他の文書の見た目を 1px も変えない）
    if (!hasAudio) return null;

    const duration = snapshot.durationSec;
    const onTimeUpdate = (event: React.SyntheticEvent<HTMLAudioElement>): void => {
        transcriptPlayback.patch({ currentSec: event.currentTarget.currentTime || 0 });
    };
    const onLoadedMetadata = (event: React.SyntheticEvent<HTMLAudioElement>): void => {
        transcriptPlayback.patch({ durationSec: safeDuration(event.currentTarget.duration) });
        transcriptPlayback.markAudioReady();
    };
    const onMediaLoaded = (): void => transcriptPlayback.markAudioReady();
    const onError = (): void => {
        transcriptPlayback.setAudio('unavailable', 'media_failed');
        onMediaError?.();
    };

    return (
        <div
            data-testid="transcript-player"
            aria-label="文字起こしの音声"
            className={[
                'sticky bottom-0 z-10 flex items-center gap-2 sm:gap-3 border-t border-gray-200',
                'bg-white/95 px-3 py-1.5 backdrop-blur-sm print:hidden',
                className ?? '',
            ].join(' ')}
        >
            <audio
                ref={audioRef}
                src={audioUrl ?? undefined}
                preload="metadata"
                className="hidden"
                onTimeUpdate={onTimeUpdate}
                onLoadedMetadata={onLoadedMetadata}
                onLoadedData={onMediaLoaded}
                onCanPlay={onMediaLoaded}
                // preload を尊重しないブラウザは読み込みを中断（suspend）する。押せば読み込みが始まるので待たせない
                onSuspend={onMediaLoaded}
                onError={onError}
                onPlay={() => transcriptPlayback.patch({ playing: true, playbackBlocked: false })}
                onPause={() => transcriptPlayback.patch({ playing: false })}
                onEnded={() => transcriptPlayback.patch({ playing: false })}
            />
            <button
                type="button"
                onClick={() => (snapshot.playing ? pause() : play())}
                aria-label={snapshot.playing ? '一時停止' : '再生'}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-purple-100 text-purple-700 transition-colors hover:bg-purple-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
            >
                {snapshot.playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </button>
            <span
                data-testid="transcript-player-time"
                className="shrink-0 font-mono text-xs tabular-nums text-gray-500"
            >
                {formatTimestamp(snapshot.currentSec)} / {duration > 0 ? formatTimestamp(duration) : '--:--'}
            </span>
            <input
                type="range"
                aria-label="再生位置"
                min={0}
                max={duration > 0 ? duration : 0}
                step={0.1}
                value={Math.min(snapshot.currentSec, duration > 0 ? duration : snapshot.currentSec)}
                disabled={duration <= 0}
                onChange={event => transcriptPlayback.seek(Number(event.target.value))}
                className="h-1 min-w-0 flex-1 cursor-pointer accent-purple-600 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <button
                type="button"
                aria-pressed={snapshot.follow}
                onClick={() => transcriptPlayback.setFollow(!snapshot.follow)}
                title={snapshot.follow ? '再生中の行へのスクロール追従を止める' : '再生中の行へスクロール追従する'}
                className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 ${
                    snapshot.follow
                        ? 'bg-purple-100 text-purple-700'
                        : 'text-gray-500 hover:text-gray-900'
                }`}
            >
                <Crosshair className="h-3.5 w-3.5" />
                <span>追従</span>
            </button>
        </div>
    );
}

export default TranscriptPlayer;
