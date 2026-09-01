import { describe, expect, it, vi } from 'vitest';
import {
    SUPPORTED_MEDIA_ACCEPT,
    SUPPORTED_MEDIA_FORMATS,
    SUPPORTED_MEDIA_LABELS,
    consumeFileInput,
    getSupportedMediaKind,
    getSupportedMediaMimeType,
    isSupportedMediaFile,
} from './FileDropZone';

const asFile = (name: string, type = '') => ({ name, type }) as File;

describe('FileDropZone media format contract', () => {
    it('accepts every displayed extension without relying on MIME', () => {
        for (const format of SUPPORTED_MEDIA_FORMATS) {
            const file = asFile(`sample${format.extension.toUpperCase()}`);
            expect(isSupportedMediaFile(file), format.label).toBe(true);
            expect(getSupportedMediaKind(file), format.label).toBe(format.kind);
        }
    });

    it('rejects unknown extensions even when the MIME type is explicitly supported', () => {
        for (const format of SUPPORTED_MEDIA_FORMATS) {
            for (const mimeType of format.mimeTypes) {
                expect(isSupportedMediaFile(asFile('sample.unknown', mimeType)), mimeType).toBe(false);
            }
        }

        expect(isSupportedMediaFile(asFile('clip.wmv', 'video/mp4'))).toBe(false);
        expect(isSupportedMediaFile(asFile('voice.aiff', 'audio/mpeg'))).toBe(false);
        expect(isSupportedMediaFile(asFile('no-extension', 'video/mp4'))).toBe(false);
        expect(isSupportedMediaFile(asFile('clip.wmv', 'video/x-ms-wmv'))).toBe(false);
        expect(isSupportedMediaFile(asFile('voice.aiff', 'audio/aiff'))).toBe(false);
        expect(isSupportedMediaFile(asFile('clip.bin', 'video/unknown'))).toBe(false);
        expect(isSupportedMediaFile(asFile('voice.bin', 'audio/unknown'))).toBe(false);
    });

    it('uses a known extension as the source of truth for kind and MIME', () => {
        expect(getSupportedMediaKind(asFile('clip.MP4', 'audio/mpeg'))).toBe('video');
        expect(getSupportedMediaMimeType(asFile('clip.MP4', 'audio/mpeg'))).toBe('video/mp4');
        expect(getSupportedMediaKind(asFile('voice.MP3', 'video/mp4'))).toBe('audio');
        expect(getSupportedMediaMimeType(asFile('voice.MP3', 'video/mp4'))).toBe('audio/mpeg');
    });

    it('derives a valid MIME type from every supported extension when MIME is empty', () => {
        for (const format of SUPPORTED_MEDIA_FORMATS) {
            expect(
                getSupportedMediaMimeType(asFile(`sample${format.extension}`, '')),
                format.label
            ).toBe(format.mimeTypes[0]);
        }

        expect(getSupportedMediaMimeType(asFile('clip.wmv', ''))).toBeNull();
    });

    it('derives accept and displayed labels from the single format list', () => {
        const acceptTokens = SUPPORTED_MEDIA_ACCEPT.split(',');
        const expectedTokens = SUPPORTED_MEDIA_FORMATS.flatMap(format => [
            format.extension,
            ...format.mimeTypes,
        ]);

        expect(acceptTokens).toEqual(expectedTokens);
        expect(acceptTokens).not.toContain('video/*');
        expect(acceptTokens).not.toContain('audio/*');
        expect(SUPPORTED_MEDIA_LABELS.video).toBe('MP4, MOV, AVI, MKV, WebM');
        expect(SUPPORTED_MEDIA_LABELS.audio).toBe('MP3, WAV, M4A, AAC, OGG, FLAC');
    });
});

describe('consumeFileInput', () => {
    it.each([
        ['supported', [asFile('sample.mp4')]],
        ['rejected', [asFile('sample.txt', 'text/plain')]],
        ['empty', []],
    ])('clears the input after a %s selection', (_name, files) => {
        const input = {
            files: files as unknown as FileList,
            value: 'C:\\fakepath\\selected-file',
        };
        const consume = vi.fn();

        consumeFileInput(input, consume);

        expect(consume).toHaveBeenCalledWith(files);
        expect(input.value).toBe('');
    });

    it('clears the input even if the selection callback throws', () => {
        const input = {
            files: [asFile('sample.mp4')] as unknown as FileList,
            value: 'C:\\fakepath\\sample.mp4',
        };

        expect(() => consumeFileInput(input, () => {
            throw new Error('selection failed');
        })).toThrow('selection failed');
        expect(input.value).toBe('');
    });
});
