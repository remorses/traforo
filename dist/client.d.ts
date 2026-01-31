/**
 * Local tunnel client - runs on user's machine to expose a local server.
 */
type TunnelClientOptions = {
    /** Local port to proxy to */
    localPort: number;
    /** Local host (default: localhost) */
    localHost?: string;
    /** Tunnel server URL (default: wss://{tunnelId}-tunnel.kimaki.xyz) */
    serverUrl?: string;
    /** Tunnel ID */
    tunnelId: string;
    /** Use HTTPS for local connections */
    localHttps?: boolean;
    /** Reconnect on disconnect */
    autoReconnect?: boolean;
    /** Reconnect delay in ms */
    reconnectDelay?: number;
};
export declare class TunnelClient {
    private options;
    private ws;
    private localWsConnections;
    private closed;
    constructor(options: TunnelClientOptions);
    get url(): string;
    connect(): Promise<void>;
    close(): void;
    private handleMessage;
    private handleHttpRequest;
    private handleWsOpen;
    private handleWsFrame;
    private handleWsClose;
    private send;
}
export {};
