export class PlaybookError extends Error { status: number; constructor(message: string, status?: number); }
export type PlaybookPrincipal = { userId: string; name: string; demo: boolean };
export type PlaybookClient = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[]; rowCount: number | null }> };
export function runPlaybookOperation(client: PlaybookClient, principal: PlaybookPrincipal, matterId: string, input: unknown, now?: string): Promise<Record<string, unknown>>;
