'use client';

import React from 'react';
import { Prompt } from '@/lib/prompts';
import { PromptEditModal } from '@/components/PromptEditModal';
import { PromptCreateModal } from '@/components/PromptCreateModal';

interface PromptModalsProps {
  selectedPrompt: Prompt | null;
  onClosePrompt: () => void;
  isCreateOpen: boolean;
  onCloseCreate: () => void;
  onSave: () => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
}

export const PromptModals: React.FC<PromptModalsProps> = ({
  selectedPrompt,
  onClosePrompt,
  isCreateOpen,
  onCloseCreate,
  onSave,
  onDelete,
}) => {
  return (
    <>
      <PromptEditModal
        isOpen={!!selectedPrompt}
        onClose={onClosePrompt}
        prompt={selectedPrompt}
        onSave={onSave}
        onDelete={onDelete}
      />
      <PromptCreateModal isOpen={isCreateOpen} onClose={onCloseCreate} onSave={onSave} />
    </>
  );
};


