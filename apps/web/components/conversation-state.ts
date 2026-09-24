import type { AgentEvent } from '@cloud-work/protocol';

export type PendingState = 'sending' | 'verifying' | 'accepted' | 'failed';
export type UserBlock = {
    key: string;
    type: 'user';
    text: string;
    turnId: string;
    requestId?: string;
    pending?: PendingState;
    sendError?: string;
};
export type Block = UserBlock | {
    key: string;
    type: 'assistant' | 'error';
    text: string;
    turnId: string;
    code?: string;
} | {
    key: string;
    type: 'tool';
    turnId: string;
    name: string;
    input?: unknown;
    output?: unknown;
    complete: boolean;
};
export type ConversationState = { blocks: Block[]; status: string; seen: Set<string> };
export type Action =
    | { type: 'restore'; state: ConversationState }
    | { type: 'status'; status: string }
    | { type: 'optimistic'; requestId: string; text: string }
    | { type: 'pending'; requestId: string; pending?: PendingState; sendError?: string }
    | { type: 'event'; id: string; event: AgentEvent };

export function emptyConversation(status = 'idle'): ConversationState {
    return { blocks: [], status, seen: new Set<string>() };
}

function activeTurn(blocks: Block[], fallback: string) {
    return [...blocks].reverse().find(block => block.type === 'user')?.turnId ?? fallback;
}

export function reduceConversation(state: ConversationState, action: Action): ConversationState {
    if (action.type === 'restore') return action.state;
    if (action.type === 'status') return { ...state, status: action.status };
    if (action.type === 'optimistic') {
        const existing = state.blocks.findIndex(block => block.type === 'user' && block.requestId === action.requestId);
        if (existing >= 0) {
            const blocks = [...state.blocks];
            const block = blocks[existing];
            if (block?.type === 'user') blocks[existing] = { ...block, pending: 'sending', sendError: undefined };
            return { ...state, blocks, status: 'starting' };
        }
        return { ...state, blocks: [...state.blocks, { key: action.requestId, type: 'user', text: action.text, turnId: action.requestId, requestId: action.requestId, pending: 'sending' }], status: 'starting' };
    }
    if (action.type === 'pending') {
        return { ...state, blocks: state.blocks.map(block => block.type === 'user' && block.requestId === action.requestId ? { ...block, pending: action.pending, sendError: action.sendError } : block) };
    }
    if (action.id && state.seen.has(action.id)) return state;
    const seen = new Set(state.seen);
    if (action.id) seen.add(action.id);
    const event = action.event;
    const blocks = [...state.blocks];
    const key = action.id || `${Date.now()}-${blocks.length}`;
    if (event.type === 'user-message') {
        const optimistic = blocks.findIndex(block => block.type === 'user' && (event.requestId ? block.requestId === event.requestId : !!block.pending && block.text === event.text));
        if (optimistic >= 0) {
            const block = blocks[optimistic]!;
            blocks[optimistic] = { key, type: 'user', text: event.text, turnId: block.turnId, ...(event.requestId ? { requestId: event.requestId } : {}) };
        } else {
            blocks.push({ key, type: 'user', text: event.text, turnId: event.requestId || key, ...(event.requestId ? { requestId: event.requestId } : {}) });
        }
    } else if (event.type === 'text-delta') {
        const turnId = activeTurn(blocks, key);
        const last = blocks[blocks.length - 1];
        if (last?.type === 'assistant' && last.turnId === turnId)
            blocks[blocks.length - 1] = { ...last, text: last.text + event.text };
        else blocks.push({ key, type: 'assistant', text: event.text, turnId });
    } else if (event.type === 'tool-start') {
        blocks.push({ key: event.id, type: 'tool', turnId: activeTurn(blocks, key), name: event.name, input: event.input, complete: false });
    } else if (event.type === 'tool-result') {
        const index = blocks.findLastIndex(block => block.type === 'tool' && block.key === event.id);
        const tool = blocks[index];
        if (index >= 0 && tool?.type === 'tool') blocks[index] = { ...tool, output: event.output, complete: true };
        else blocks.push({ key: event.id, type: 'tool', turnId: activeTurn(blocks, key), name: 'Tool result', output: event.output, complete: true });
    } else if (event.type === 'error') {
        blocks.push({ key, type: 'error', text: event.message, code: event.code, turnId: activeTurn(blocks, key) });
    }
    return { blocks, seen, status: event.type === 'status' ? event.status : state.status };
}
