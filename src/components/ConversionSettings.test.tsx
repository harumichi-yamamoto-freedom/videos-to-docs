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
    it('既定は 96k (主用途の 2〜3 時間の商談が 128k では上限に届かない)', () => {
        expect(DEFAULT_AUDIO_BITRATE).toBe('96k');
        expect(AUDIO_BITRATE_OPTIONS.map(option => option.value)).toContain(DEFAULT_AUDIO_BITRATE);
        // 既定は 2 時間の商談をそのまま扱えること (128k の約 109 分では足りない)
        expect(estimateMaxRecordingMinutes(DEFAULT_AUDIO_BITRATE)).toBeGreaterThanOrEqual(120);
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

    it('各選択肢に Storage 上限 (100MB) から逆算した「扱える録音の長さ」を出す', () => {
        const markup = render('96k');
        expect(markup).toContain('約3時間38分までの録音に対応');
        expect(markup).toContain('約2時間25分までの録音に対応');
        expect(markup).toContain('約1時間49分までの録音に対応');
        expect(markup).toContain('約1時間12分までの録音に対応');
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
