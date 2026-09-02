import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
    AUDIO_BITRATE_OPTIONS,
    ConversionSettings,
    DEFAULT_AUDIO_BITRATE,
} from './ConversionSettings';

const render = (bitrate: string, disabled = false) =>
    renderToStaticMarkup(
        <ConversionSettings bitrate={bitrate} onBitrateChange={vi.fn()} disabled={disabled} />,
    );

const radios = (markup: string): string[] =>
    [...markup.matchAll(/<input\b[^>]*type="radio"[^>]*>/g)].map(match => match[0]);

describe('ConversionSettings (S2-1: ビットレート選択)', () => {
    it('既定は安全側の 128k (192k だと約 10 分で送れなくなる)', () => {
        expect(DEFAULT_AUDIO_BITRATE).toBe('128k');
        expect(AUDIO_BITRATE_OPTIONS.map(option => option.value)).toContain(DEFAULT_AUDIO_BITRATE);
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

    it('各選択肢に「そのまま送れる目安」の分数を出す', () => {
        const markup = render('128k');
        expect(markup).toContain('約26分');
        expect(markup).toContain('約17分');
        expect(markup).toContain('約13分');
        expect(markup).toContain('約8分');
    });

    it('処理中は fieldset ごと無効になる', () => {
        expect(render('128k', true)).toMatch(/<fieldset[^>]*\bdisabled\b/);
        expect(render('128k', false)).not.toMatch(/<fieldset[^>]*\bdisabled\b/);
    });
});
