import { useState, useCallback } from 'react';
import { FileWithPrompts } from '@/types/processing';

export const useFileManagement = (bulkSelectedPromptIds: string[]) => {
    const [selectedFiles, setSelectedFiles] = useState<FileWithPrompts[]>([]);

    const handleFilesSelected = useCallback((files: File[]) => {
        const filesWithPrompts: FileWithPrompts[] = files.map(file => ({
            file,
            selectedPromptIds: [...bulkSelectedPromptIds]
        }));
        setSelectedFiles(prev => [...prev, ...filesWithPrompts]);
    }, [bulkSelectedPromptIds]);

    const handleRemoveFile = useCallback((index: number) => {
        setSelectedFiles(prev => prev.filter((_, i) => i !== index));
    }, []);

    const toggleFilePrompt = useCallback((fileIndex: number, promptId: string) => {
        setSelectedFiles(prev => prev.map((fileWithPrompts, idx) => {
            if (idx === fileIndex) {
                const selectedPromptIds = fileWithPrompts.selectedPromptIds.includes(promptId)
                    ? fileWithPrompts.selectedPromptIds.filter(id => id !== promptId)
                    : [...fileWithPrompts.selectedPromptIds, promptId];
                return {
                    ...fileWithPrompts,
                    selectedPromptIds
                };
            }
            return fileWithPrompts;
        }));
    }, []);

    const clearFiles = useCallback(() => {
        setSelectedFiles([]);
    }, []);

    return {
        selectedFiles,
        handleFilesSelected,
        handleRemoveFile,
        toggleFilePrompt,
        clearFiles,
    };
};

