// ============================================
// Messages: Worker/DO → Local Client (upstream)
// ============================================
// ============================================
// Helper functions
// ============================================
// Helper to create type-safe messages
export function createMessage(msg) {
    return JSON.stringify(msg);
}
// Helper to parse messages with type narrowing
export function parseUpstreamMessage(data) {
    try {
        const msg = JSON.parse(data);
        if (!msg.type) {
            return null;
        }
        return msg;
    }
    catch {
        return null;
    }
}
export function parseDownstreamMessage(data) {
    try {
        const msg = JSON.parse(data);
        if (!msg.type) {
            return null;
        }
        return msg;
    }
    catch {
        return null;
    }
}
