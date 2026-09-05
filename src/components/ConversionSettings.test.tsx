import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
    AUDIO_BITRATE_OPTIONS,
    ConversionSettings,
    DEFAULT_AUDIO_BITRATE,
} from './ConversionSettings';
import { estimateMaxRecordingMinutes } from '@/lib/inlineMediaBudget';

const render = (bitrate: string, disabled = false) =>
    renderToStaticMarkup(
        <ConversionSettings bitrate={bitrate} onBitrateChange={vi.fn()} disabled={disabled} />,
    );

const radios = (markup: string): string[] =>
    [...markup.matchAll(/<input\b[^>]*type="radio"[^>]*>/g)].map(match => match[0]);

describe('ConversionSettings (S2-1: ビットレート選択)', () => {
    it('既定は 96k (音声認識には十分。サイズ上限 500MB では 4 時間の商談も余裕で収まる)', () => {
        expect(DEFAULT_AUDIO_BITRATE).toBe('96k');
        expect(AUDIO_BITRATE_OPTIONS.map(option => option.value)).toContain(DEFAULT_AUDIO_BITRATE);
        // 既定は主用途の 2〜3 時間の商談（〜4 時間の文字起こし上限）をサイズ上限内で扱えること
        expect(estimateMaxRecordingMinutes(DEFAULT_AUDIO_BITRATE)).toBeGreaterThanOrEqual(240);
    });

    it('64 / 96 / 128 / 192 kbps を選べる', () => {
        expect(AUDIO_BITRATE_OPTIONS.map(option => option.value)).toEqual(['64k', '96k', '128k', '192k']);
        expect(radios(render('128k'))).toHaveLength(4);
    });

    it('現在値のラジオだけが checked', () => {
        const checked = radios(render('64k')).filter(tag => tag.includes('checked'));
        expect(checked).toHaveLength(1);
        expect(checked[0]).toContain('value="64k"');
    });

    it('「扱える録音の長さ」は全文文字起こしの上限 (4時間) で頭打ちにする (500MB では全ビットレートがサイズより先に時間上限へ)', () => {
        const markup = render('96k');
        // 500MB のサイズ上限では全ビットレートが 4 時間ぶんを超える → 表示は文字起こしの上限 4 時間で頭打ち
        expect(markup).toContain('約4時間までの録音に対応');
        // サイズ由来の生の長さ (18/12/9/6 時間) は出さない: 文字起こしできない長さを「対応」と誤認させないため
        for (const stale of ['約18時間', '約12時間', '約9時間', '約6時間']) {
            expect(markup).not.toContain(stale);
        }
    });

    it('inline 予算 (Files API へ迂回すれば超えられる内部の分岐点) の分数は出さない', () => {
        // 実害: 64k に「そのまま送れる目安: 約26分」と出て、2〜3 時間の商談が扱えないと読めていた
        const markup = render('96k');
        for (const stale of ['約26分', '約17分', '約13分', '約8分', 'そのまま送れる']) {
            expect(markup).not.toContain(stale);
        }
    });

    it('処理中は fieldset ごと無効になる', () => {
        expect(render('128k', true)).toMatch(/<fieldset[^>]*\bdisabled\b/);
        expect(render('128k', false)).not.toMatch(/<fieldset[^>]*\bdisabled\b/);
    });
});
