export type HttpRequestMessage = {
    type: 'http_request';
    id: string;
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string | null;
};
export type WsOpenMessage = {
    type: 'ws_open';
    connId: string;
    path: string;
    headers: Record<string, string>;
};
export type WsFrameMessage = {
    type: 'ws_frame';
    connId: string;
    data: string;
    binary?: boolean;
};
export type WsCloseMessage = {
    type: 'ws_close';
    connId: string;
    code: number;
    reason: string;
};
export type UpstreamMessage = HttpRequestMessage | WsOpenMessage | WsFrameMessage | WsCloseMessage;
export type HttpResponseMessage = {
    type: 'http_response';
    id: string;
    status: number;
    headers: Record<string, string>;
    body: string | null;
};
export type HttpResponseStartMessage = {
    type: 'http_response_start';
    id: string;
    status: number;
    headers: Record<string, string>;
};
export type HttpResponseChunkMessage = {
    type: 'http_response_chunk';
    id: string;
    chunk: string;
};
export type HttpResponseEndMessage = {
    type: 'http_response_end';
    id: string;
};
export type HttpErrorMessage = {
    type: 'http_error';
    id: string;
    error: string;
};
export type WsOpenedMessage = {
    type: 'ws_opened';
    connId: string;
};
export type WsFrameResponseMessage = {
    type: 'ws_frame';
    connId: string;
    data: string;
    binary?: boolean;
};
export type WsClosedMessage = {
    type: 'ws_closed';
    connId: string;
    code: number;
    reason: string;
};
export type WsErrorMessage = {
    type: 'ws_error';
    connId: string;
    error: string;
};
export type DownstreamMessage = HttpResponseMessage | HttpResponseStartMessage | HttpResponseChunkMessage | HttpResponseEndMessage | HttpErrorMessage | WsOpenedMessage | WsFrameResponseMessage | WsClosedMessage | WsErrorMessage;
export type UpstreamConnectedEvent = {
    event: 'upstream_connected';
};
export type UpstreamDisconnectedEvent = {
    event: 'upstream_disconnected';
};
export type DownstreamEvent = UpstreamConnectedEvent | UpstreamDisconnectedEvent;
export declare function createMessage<T extends UpstreamMessage | DownstreamMessage>(msg: T): string;
export declare function parseUpstreamMessage(data: string): UpstreamMessage | null;
export declare function parseDownstreamMessage(data: string): DownstreamMessage | null;
