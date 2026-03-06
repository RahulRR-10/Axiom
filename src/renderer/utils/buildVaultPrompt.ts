import type { SearchResult } from '../../shared/types';

const MAX_CONTEXT_CHARS = 4800; // ~1200 tokens

export function buildVaultPrompt(
    question: string,
    chunks: SearchResult[],
): string {
    let budget = MAX_CONTEXT_CHARS;
    const trimmed: SearchResult[] = [];

    for (const chunk of chunks) {
        if (budget <= 0) break;
        trimmed.push(chunk);
        budget -= chunk.text.length;
    }

    const material =
        trimmed.length > 0
            ? trimmed
                .map((c) => {
                    const loc = c.page_or_slide ? ` — Page ${c.page_or_slide}` : '';
                    return `[File: ${c.file_name}${loc}]\n${c.text}`;
                })
                .join('\n\n')
            : null;

    return [
        'You are a study assistant.',
        '',
        'Answer the question using ONLY the provided study material below.',
        'If the material does not contain the answer, say:',
        '"I could not find this in the study material."',
        '',
        ...(material
            ? ['STUDY MATERIAL', '--------------', material, '']
            : []),
        'QUESTION',
        '--------',
        question,
    ].join('\n');
}
