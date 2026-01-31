export declare const CLI_NAME = "traforo";
export type RunTunnelOptions = {
    port: number;
    tunnelId?: string;
    localHost?: string;
    serverUrl?: string;
    command?: string[];
};
/**
 * Parse argv to extract command after `--` separator.
 * Returns the command array and remaining argv without the command.
 */
export declare function parseCommandFromArgv(argv: string[]): {
    command: string[];
    argv: string[];
};
/**
 * Run the tunnel, optionally spawning a child process first.
 */
export declare function runTunnel(options: RunTunnelOptions): Promise<void>;
