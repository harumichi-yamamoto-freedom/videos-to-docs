import React from 'react';
import ReactMarkdown, { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

type CodeProps = React.HTMLAttributes<HTMLElement> & { inline?: boolean };

const markdownComponents: Components = {
    h1: (props) => (
        <h1 className="text-2xl font-bold mt-6 mb-4 text-gray-900" {...props} />
    ),
    h2: (props) => (
        <h2 className="text-xl font-bold mt-5 mb-3 text-gray-900" {...props} />
    ),
    h3: (props) => (
        <h3 className="text-lg font-bold mt-4 mb-2 text-gray-900" {...props} />
    ),
    ul: (props) => (
        <ul className="list-disc pl-6 mb-4 space-y-1" {...props} />
    ),
    ol: (props) => (
        <ol className="list-decimal pl-6 mb-4 space-y-1" {...props} />
    ),
    li: (props) => (
        <li className="leading-relaxed" {...props} />
    ),
    p: (props) => (
        <p className="mb-4 leading-relaxed" {...props} />
    ),
    blockquote: (props) => (
        <blockquote
            className="border-l-4 border-purple-300 pl-4 italic my-4 text-gray-700"
            {...props}
        />
    ),
    code: ({ inline, ...props }: CodeProps) =>
        inline ? (
            <code
                className="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono text-purple-600"
                {...props}
            />
        ) : (
            <code
                className="block bg-gray-100 p-4 rounded-lg text-sm font-mono overflow-x-auto mb-4"
                {...props}
            />
        ),
    pre: (props) => (
        <pre className="bg-gray-100 p-4 rounded-lg overflow-x-auto mb-4" {...props} />
    ),
    strong: (props) => (
        <strong className="font-bold text-gray-900" {...props} />
    ),
    em: (props) => (
        <em className="italic" {...props} />
    ),
    a: (props) => (
        <a
            className="text-blue-600 hover:text-blue-800 underline"
            target="_blank"
            rel="noopener noreferrer"
            {...props}
        />
    ),
};

export type MarkdownDocumentProps = {
    markdown: string;
    className?: string;
};

export const MarkdownDocument = React.memo(function MarkdownDocument({
    markdown,
    className,
}: MarkdownDocumentProps): React.ReactElement {
    return (
        <div className={className}>
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={markdownComponents}
            >
                {markdown}
            </ReactMarkdown>
        </div>
    );
});
