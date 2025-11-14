'use client';

import React, { useState } from 'react';
import { DocumentListSidebar } from '@/components/DocumentListSidebar';
import { DocumentDetailPanel } from '@/components/DocumentDetailPanel';
import { Transcription } from '@/lib/firestore';

export default function DocumentsPage() {
  const [selectedDocument, setSelectedDocument] = useState<Transcription | null>(null);
  const [documentUpdateTrigger, setDocumentUpdateTrigger] = useState(0);

  const handleDocumentClick = (transcription: Transcription) => {
    setSelectedDocument(transcription);
  };

  const handleTitleUpdate = async (newTitle: string) => {
    if (!selectedDocument) return;
    const { updateTranscriptionTitle } = await import('@/lib/firestore');
    await updateTranscriptionTitle(selectedDocument.id!, newTitle);
    setDocumentUpdateTrigger(prev => prev + 1);
    setSelectedDocument(prev => (prev ? { ...prev, title: newTitle } : prev));
  };

  const handleContentUpdate = async (newContent: string) => {
    if (!selectedDocument) return;
    const { updateTranscriptionContent } = await import('@/lib/firestore');
    await updateTranscriptionContent(selectedDocument.id!, newContent);
    setDocumentUpdateTrigger(prev => prev + 1);
    setSelectedDocument(prev => (prev ? { ...prev, text: newContent } : prev));
  };

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex flex-col lg:flex-row gap-6">
        <div className="lg:w-3/10 w-full">
          <div className="bg-white rounded-xl shadow-lg overflow-hidden h-[calc(100vh-125px)] min-h-[532px]">
            <DocumentListSidebar
              onDocumentClick={handleDocumentClick}
              updateTrigger={documentUpdateTrigger}
              selectedDocumentId={selectedDocument?.id}
            />
          </div>
        </div>
        <div className="lg:w-7/10 w-full">
          <div className="h-[calc(100vh-125px)] min-h-[532px]">
            <DocumentDetailPanel
              document={selectedDocument}
              onTitleUpdate={handleTitleUpdate}
              onContentUpdate={handleContentUpdate}
            />
          </div>
        </div>
      </div>
    </div>
  );
}


